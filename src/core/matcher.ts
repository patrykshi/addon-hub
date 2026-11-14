import { parse as pttParse } from 'parse-torrent-title';
import type { DefaultParserResult } from 'parse-torrent-title';
import type { LanguageMode, ResolutionKey, StreamHubConfig } from './config.ts';
import type { CanonicalMetadata } from './metadata.ts';

export interface StremioStreamBehaviorHints {
  bingeGroup?: string;
  notWebReady?: boolean;
  proxyHeaders?: {
    request?: Record<string, string>;
    response?: Record<string, string>;
  };
  filename?: string;
  countryWhitelist?: string[];
  videoHash?: string;
  videoSize?: number;
  [key: string]: unknown;
}

export interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  ytId?: string;
  sources?: string[];
  behaviorHints?: StremioStreamBehaviorHints;
  [key: string]: unknown;
}

export interface RawAddonStream {
  addonName: string;
  stream: StremioStream;
}

export interface MatchContext {
  type: string;
  canonicalMeta: CanonicalMetadata;
  reqSeason?: number;
  reqEpisode?: number;
}

export interface ParsedRelease extends DefaultParserResult {
  episodes?: number[];
  seasons?: number[];
}

export interface FilterEvaluation {
  pass: boolean;
  reason?: string;
}

const PTBR_REGEX =
  /\b(pt-?br|dublado|dual|portugues|português|nacional|leg-?pt|multi-?audio|dub)\b|🇧🇷/iu;
const DEBRID_CACHE_REGEX =
  /(\+|⚡|\[RD\+\]|\[TB\+\]|\[AD\+\]|\[PM\+\]|\[DL\+\]|\binstant\b|\bcached\b)/i;
const TORRENT_SCENE_REGEX =
  /\b(x264|x265|h\.?264|h\.?265|hevc|avc|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|hdrip|hdtv|dvdrip|remux)\b|\.(mkv|mp4|avi|mov|ts)\b/i;
const JUNK_ACTION_URL_REGEX = /\/(act\/rate|act\/rep|report|rate)\//i;
const JUNK_ACTION_TEXT_REGEX =
  /(toque para dar nota|m[eé]dia do grupo aparecer|toque para avisar a administra|o [aá]udio n[aã]o era o anunciado|link que n[aã]o abre ou n[aã]o carrega|aviso importante|manuten[cç][aã]o|servidor offline)/i;

const RESOLUTION_RANK: Record<ResolutionKey | 'unknown', number> = {
  '2160p': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
  unknown: 0,
};

export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeTokenOverlap(a: string, b: string): number {
  const tokensA = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  return intersection / Math.max(tokensA.size, tokensB.size);
}

export function isTitleMatch(parsedTitle: string, canonicalTitles: string[]): boolean {
  const normParsed = normalizeTitle(parsedTitle);
  if (!normParsed || normParsed.length <= 3) return true;
  if (canonicalTitles.length === 0) return true;

  for (const candidate of canonicalTitles) {
    const normCandidate = normalizeTitle(candidate);
    if (!normCandidate) continue;

    if (normCandidate === normParsed) return true;
    if (
      normCandidate.length >= 4 &&
      normParsed.length >= 4 &&
      (normCandidate.includes(normParsed) || normParsed.includes(normCandidate))
    ) {
      return true;
    }

    if (computeTokenOverlap(normParsed, normCandidate) >= 0.6) {
      return true;
    }
  }

  return false;
}

export function buildRawStreamText(stream: StremioStream): string {
  return [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints?.filename,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ');
}

function firstNonEmptyLine(value?: string): string {
  if (typeof value !== 'string') return '';
  const line = value.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : '';
}

export function parseStreamRelease(stream: StremioStream): ParsedRelease {
  const filename =
    typeof stream.behaviorHints?.filename === 'string'
      ? stream.behaviorHints.filename.trim()
      : '';

  const primaryLine =
    firstNonEmptyLine(stream.title) || firstNonEmptyLine(stream.description);
  const bodyText = [primaryLine, stream.description, stream.name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ');

  const primary = filename
    ? (pttParse(filename) as ParsedRelease)
    : (pttParse(primaryLine || bodyText) as ParsedRelease);

  if (bodyText) {
    const secondary = pttParse(bodyText) as ParsedRelease;
    return {
      ...secondary,
      ...primary,
      title: primary.title || secondary.title,
      year: primary.year ?? secondary.year,
      season: primary.season ?? secondary.season,
      episode: primary.episode ?? secondary.episode,
      resolution: primary.resolution ?? secondary.resolution,
    };
  }

  return primary;
}

function extractExplicitEpisodeMarkers(rawText: string): Array<{ season?: number; episode: number }> {
  const markers: Array<{ season?: number; episode: number }> = [];
  const sxxExxRegex = /\bS(\d{1,2})E(\d{1,3})(?:[-–E](\d{1,3}))?\b/gi;
  for (const match of rawText.matchAll(sxxExxRegex)) {
    const season = Number.parseInt(match[1], 10);
    const epStart = Number.parseInt(match[2], 10);
    const epEnd = match[3] ? Number.parseInt(match[3], 10) : epStart;
    if (epEnd >= epStart && epEnd - epStart <= 25) {
      for (let ep = epStart; ep <= epEnd; ep += 1) {
        markers.push({ season, episode: ep });
      }
    } else {
      markers.push({ season, episode: epStart });
    }
  }

  const xNotationRegex = /\b(\d{1,2})x(\d{1,3})\b/gi;
  for (const match of rawText.matchAll(xNotationRegex)) {
    markers.push({
      season: Number.parseInt(match[1], 10),
      episode: Number.parseInt(match[2], 10),
    });
  }

  return markers;
}

export function isTorrentSceneRelease(stream: StremioStream, rawText: string): boolean {
  if (stream.infoHash) return true;
  if (typeof stream.behaviorHints?.filename === 'string' && stream.behaviorHints.filename.trim()) {
    return true;
  }
  return TORRENT_SCENE_REGEX.test(rawText);
}

export function hasTorrentReleaseStructure(rawText: string, parsed: ParsedRelease): boolean {
  if (parsed.year !== undefined || parsed.season !== undefined || parsed.episode !== undefined) {
    return true;
  }
  if (/\bS\d{1,2}(?:E\d{1,3})?\b/i.test(rawText)) return true;
  if (/\b\d{1,2}x\d{1,3}\b/i.test(rawText)) return true;
  if (/\b(19|20)\d{2}\b/.test(rawText)) return true;
  return false;
}

export function isJunkOrActionStream(stream: StremioStream, rawText: string): boolean {
  const urls = [stream.url, stream.externalUrl].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  if (urls.some((u) => JUNK_ACTION_URL_REGEX.test(u))) {
    return true;
  }
  return JUNK_ACTION_TEXT_REGEX.test(rawText);
}

function extractParenthesizedYears(text: string): number[] {
  const years: number[] = [];
  const regex = /\(((?:19|20)\d{2})\)/g;
  for (const match of text.matchAll(regex)) {
    const year = Number.parseInt(match[1], 10);
    if (Number.isFinite(year)) {
      years.push(year);
    }
  }
  return years;
}

export function passesStrictMetaMatch(
  stream: StremioStream,
  parsed: ParsedRelease,
  rawText: string,
  context: MatchContext,
): FilterEvaluation {
  const { type, canonicalMeta, reqSeason, reqEpisode } = context;

  const hasInfoHash = Boolean(typeof stream.infoHash === 'string' && stream.infoHash.trim());
  const hasFilename = Boolean(
    typeof stream.behaviorHints?.filename === 'string' && stream.behaviorHints.filename.trim(),
  );
  const titleAndDesc = `${stream.title || ''} ${stream.description || ''}`;
  const explicitYears = extractParenthesizedYears(titleAndDesc);

  // Mesmo em links HTTP diretos sem filename, se houver ano explícito entre parênteses no filme (ex: (2016)),
  // ele deve bater com o ano canônico (+/- 1 ano).
  if (type === 'movie' && canonicalMeta.year !== undefined && explicitYears.length > 0) {
    if (!explicitYears.some((y) => Math.abs(y - canonicalMeta.year!) <= 1)) {
      return {
        pass: false,
        reason: `explicit_year_mismatch:${explicitYears[0]}!=${canonicalMeta.year}`,
      };
    }
  }

  // Só pula o strictMetaMatch completo se for link HTTP direto genérico SEM infoHash E SEM behaviorHints.filename
  if (stream.url && !hasInfoHash && !hasFilename) {
    return { pass: true };
  }

  // Trava 1: Trava de Ano (apenas para movie)
  if (type === 'movie' && parsed.year !== undefined && canonicalMeta.year !== undefined) {
    if (Math.abs(parsed.year - canonicalMeta.year) > 1) {
      return {
        pass: false,
        reason: `year_mismatch:${parsed.year}!=${canonicalMeta.year}`,
      };
    }
  }

  // Trava 2: Trava Estrita de Temporada e Episódio (para series e anime)
  if (type === 'series' || type === 'anime') {
    const explicitMarkers = extractExplicitEpisodeMarkers(rawText);

    if (reqSeason !== undefined) {
      if (parsed.season !== undefined && parsed.season !== reqSeason) {
        return {
          pass: false,
          reason: `season_mismatch:${parsed.season}!=${reqSeason}`,
        };
      }
      if (
        explicitMarkers.length > 0 &&
        explicitMarkers.some((m) => m.season !== undefined) &&
        !explicitMarkers.some((m) => m.season === reqSeason)
      ) {
        return {
          pass: false,
          reason: `explicit_season_mismatch:req=${reqSeason}`,
        };
      }
    }

    if (reqEpisode !== undefined) {
      if (parsed.episode !== undefined && parsed.episode !== reqEpisode) {
        const coveredByRange = explicitMarkers.some(
          (m) => (m.season === undefined || m.season === reqSeason) && m.episode === reqEpisode,
        );
        if (!coveredByRange) {
          return {
            pass: false,
            reason: `episode_mismatch:${parsed.episode}!=${reqEpisode}`,
          };
        }
      }

      if (
        parsed.episode === undefined &&
        explicitMarkers.length > 0 &&
        !explicitMarkers.some(
          (m) => (m.season === undefined || m.season === reqSeason) && m.episode === reqEpisode,
        )
      ) {
        return {
          pass: false,
          reason: `explicit_episode_mismatch:req=${reqEpisode}`,
        };
      }
    }
  }

  // Trava 3: Trava de Sanidade de Título (Sanity Check)
  if (parsed.title && parsed.title.trim().length > 3 && canonicalMeta.canonicalTitles.length > 0) {
    if (!isTitleMatch(parsed.title, canonicalMeta.canonicalTitles)) {
      return {
        pass: false,
        reason: `title_mismatch:${parsed.title}`,
      };
    }
  }

  return { pass: true };
}

export function isPtBrStream(rawText: string): boolean {
  return PTBR_REGEX.test(rawText);
}

export function isDebridCached(stream: StremioStream): boolean {
  const text = [stream.name, stream.title].filter(Boolean).join(' ');
  return DEBRID_CACHE_REGEX.test(text);
}

export function normalizeResolution(parsedResolution?: string, rawText = ''): ResolutionKey | 'unknown' {
  const candidate = (parsedResolution || '').toLowerCase();
  if (candidate === '2160p' || candidate === '4k') return '2160p';
  if (candidate === '1080p') return '1080p';
  if (candidate === '720p') return '720p';
  if (candidate === '480p' || candidate === '360p') return '480p';

  if (/\b(2160p|4k|uhd)\b/i.test(rawText)) return '2160p';
  if (/\b(1080p|fhd|full\s*hd)\b/i.test(rawText)) return '1080p';
  if (/\b(720p|hd)\b/i.test(rawText)) return '720p';
  if (/\b(480p|sd)\b/i.test(rawText)) return '480p';

  return 'unknown';
}

export function formatResolutionLabel(resolution: ResolutionKey | 'unknown'): string {
  if (resolution === '2160p') return '4K';
  if (resolution === 'unknown') return 'Auto';
  return resolution;
}

export function getDedupeKey(stream: StremioStream, addonName = ''): string {
  if (stream.infoHash && typeof stream.infoHash === 'string' && stream.infoHash.trim()) {
    return `ih:${stream.infoHash.trim().toLowerCase()}-${stream.fileIdx ?? 0}`;
  }
  if (stream.url && typeof stream.url === 'string' && stream.url.trim()) {
    return `url:${stream.url.trim()}`;
  }
  if (stream.externalUrl && typeof stream.externalUrl === 'string' && stream.externalUrl.trim()) {
    return `ext:${stream.externalUrl.trim()}`;
  }
  if (stream.ytId && typeof stream.ytId === 'string' && stream.ytId.trim()) {
    return `yt:${stream.ytId.trim()}`;
  }
  return `fallback:${addonName}|${stream.name || ''}|${stream.title || ''}|${stream.description || ''}`;
}

export function formatStreamName(
  addonName: string,
  resolution: ResolutionKey | 'unknown',
  ptbr: boolean,
): string {
  const parts = [`⚡ [${addonName}]`, formatResolutionLabel(resolution)];
  if (ptbr) {
    parts.push('🇧🇷');
  }
  return parts.join(' | ');
}

interface ProcessedCandidate {
  stream: StremioStream;
  addonNames: string[];
  ptbr: boolean;
  resolution: ResolutionKey | 'unknown';
  debridCached: boolean;
  originalIndex: number;
}

export function compareCandidates(
  a: ProcessedCandidate,
  b: ProcessedCandidate,
  languageMode: LanguageMode,
): number {
  if (languageMode === 'prioritize_ptbr' && a.ptbr !== b.ptbr) {
    return a.ptbr ? -1 : 1;
  }

  const resDiff = RESOLUTION_RANK[b.resolution] - RESOLUTION_RANK[a.resolution];
  if (resDiff !== 0) return resDiff;

  if (a.debridCached !== b.debridCached) {
    return a.debridCached ? -1 : 1;
  }

  return a.originalIndex - b.originalIndex;
}

export function processStreams(
  rawStreams: RawAddonStream[],
  config: StreamHubConfig,
  context: MatchContext,
): StremioStream[] {
  const acceptedByKey = new Map<string, ProcessedCandidate>();
  const allowedRes = new Set<ResolutionKey>(config.resolutions);
  const candidates: ProcessedCandidate[] = [];

  for (let i = 0; i < rawStreams.length; i += 1) {
    const { addonName, stream } = rawStreams[i];
    if (!stream || typeof stream !== 'object') continue;

    const rawText = buildRawStreamText(stream);

    if (isJunkOrActionStream(stream, rawText)) {
      continue;
    }

    const parsed = parseStreamRelease(stream);

    if (config.strictMetaMatch) {
      const verdict = passesStrictMetaMatch(stream, parsed, rawText, context);
      if (!verdict.pass) {
        continue;
      }
    }

    const isDirectHttpStream = Boolean(stream.url && !stream.infoHash);
    const resolution = normalizeResolution(parsed.resolution, rawText);
    if (resolution === 'unknown') {
      if (!config.allowUnknownRes && !isDirectHttpStream) continue;
    } else if (!allowedRes.has(resolution)) {
      continue;
    }

    const ptbr = isPtBrStream(rawText);
    if (config.languageMode === 'only_ptbr' && !ptbr) {
      continue;
    }

    const debridCached = isDebridCached(stream);

    const dedupeKey = getDedupeKey(stream, addonName);
    const existing = acceptedByKey.get(dedupeKey);
    if (existing) {
      if (addonName && !existing.addonNames.includes(addonName)) {
        existing.addonNames.push(addonName);
        existing.stream.name = formatStreamName(
          existing.addonNames.join(' + '),
          existing.resolution,
          existing.ptbr,
        );
      }
      if (!existing.debridCached && debridCached) {
        existing.debridCached = true;
      }
      continue;
    }

    const originalName = typeof stream.name === 'string' ? stream.name.trim() : '';
    const existingDesc = typeof stream.description === 'string' ? stream.description.trim() : '';
    const existingTitle = typeof stream.title === 'string' ? stream.title.trim() : '';

    const addonNames = addonName ? [addonName] : ['Addon'];

    const formattedStream: StremioStream = {
      ...stream,
      name: formatStreamName(addonNames.join(' + '), resolution, ptbr),
      description: existingDesc || existingTitle || (originalName ? originalName : undefined),
      behaviorHints: stream.behaviorHints ? { ...stream.behaviorHints } : undefined,
    };
    if (formattedStream.description === undefined) {
      delete formattedStream.description;
    }
    if (formattedStream.behaviorHints === undefined) {
      delete formattedStream.behaviorHints;
    }

    const candidate: ProcessedCandidate = {
      stream: formattedStream,
      addonNames,
      ptbr,
      resolution,
      debridCached,
      originalIndex: i,
    };
    acceptedByKey.set(dedupeKey, candidate);
    candidates.push(candidate);
  }

  candidates.sort((a, b) => compareCandidates(a, b, config.languageMode));

  return candidates.map((c) => c.stream);
}
