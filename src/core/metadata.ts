import axios from 'axios';
import { STREMIO_CLIENT_HEADERS } from './config.ts';
import { sharedHttpAgent, sharedHttpsAgent } from './streamCache.ts';

export interface CanonicalMetadata {
  imdbId: string;
  tmdbId?: string;
  type: string;
  canonicalTitles: string[];
  year?: number;
  fetchedAt: number;
}

export interface ParsedRequestId {
  rawId: string;
  cleanId: string;
  reqSeason?: number;
  reqEpisode?: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class MetadataCache {
  private readonly store = new Map<string, CanonicalMetadata>();
  private readonly ttlMs: number;

  constructor(ttlMs = CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(key: string, now = Date.now()): CanonicalMetadata | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (now - entry.fetchedAt > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: CanonicalMetadata): void {
    if (this.store.size >= 2000) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export const globalMetadataCache = new MetadataCache();

export function parseRequestId(rawIdInput: string): ParsedRequestId {
  let decoded = rawIdInput;
  try {
    decoded = decodeURIComponent(rawIdInput);
  } catch {
    decoded = rawIdInput;
  }
  const trimmed = decoded.replace(/\.json$/i, '').trim();
  const parts = trimmed.split(':');

  // Support tt123456:1:5, tmdb:12345:1:5, kitsu:123:1
  if (parts[0] === 'tmdb' || parts[0] === 'kitsu') {
    const cleanId = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0];
    if (parts[0] === 'kitsu' && parts.length >= 3) {
      const ep = Number.parseInt(parts[2], 10);
      return {
        rawId: trimmed,
        cleanId,
        reqSeason: 1,
        reqEpisode: Number.isFinite(ep) ? ep : undefined,
      };
    }
    const season = parts.length >= 3 ? Number.parseInt(parts[2], 10) : undefined;
    const episode = parts.length >= 4 ? Number.parseInt(parts[3], 10) : undefined;
    return {
      rawId: trimmed,
      cleanId,
      reqSeason: season !== undefined && Number.isFinite(season) ? season : undefined,
      reqEpisode: episode !== undefined && Number.isFinite(episode) ? episode : undefined,
    };
  }

  const cleanId = parts[0];
  const season = parts.length >= 2 ? Number.parseInt(parts[1], 10) : undefined;
  const episode = parts.length >= 3 ? Number.parseInt(parts[2], 10) : undefined;

  return {
    rawId: trimmed,
    cleanId,
    reqSeason: season !== undefined && Number.isFinite(season) ? season : undefined,
    reqEpisode: episode !== undefined && Number.isFinite(episode) ? episode : undefined,
  };
}

export function extractYearFromValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return rounded >= 1888 && rounded <= 2100 ? rounded : undefined;
  }
  if (typeof value === 'string') {
    const match = value.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function addUniqueTitle(target: string[], candidate: unknown): void {
  if (typeof candidate !== 'string') return;
  const clean = candidate.trim();
  if (!clean) return;
  if (!target.some((item) => item.toLowerCase() === clean.toLowerCase())) {
    target.push(clean);
  }
}

interface CinemetaMetaResponse {
  meta?: {
    name?: string;
    originalName?: string;
    aliases?: string[];
    year?: number | string;
    releaseInfo?: string;
    moviedb_id?: number | string;
  };
}

interface TmdbFindResponse {
  movie_results?: Array<{
    id?: number;
    title?: string;
    original_title?: string;
    release_date?: string;
  }>;
  tv_results?: Array<{
    id?: number;
    name?: string;
    original_name?: string;
    first_air_date?: string;
  }>;
}

interface TmdbDirectResponse {
  id?: number;
  title?: string;
  original_title?: string;
  name?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  external_ids?: {
    imdb_id?: string | null;
  };
}

export function buildIdBridgeCandidates(
  parsedId: ParsedRequestId,
  canonicalMeta: CanonicalMetadata,
): { primaryId: string; alternateIds: string[]; cacheIds: string[] } {
  const epSuffix =
    parsedId.reqSeason !== undefined && parsedId.reqEpisode !== undefined
      ? `:${parsedId.reqSeason}:${parsedId.reqEpisode}`
      : parsedId.reqSeason !== undefined
        ? `:${parsedId.reqSeason}`
        : '';

  const fullImdbId =
    canonicalMeta.imdbId && canonicalMeta.imdbId.startsWith('tt')
      ? `${canonicalMeta.imdbId}${epSuffix}`
      : undefined;

  const fullTmdbPrefixed = canonicalMeta.tmdbId
    ? `tmdb:${canonicalMeta.tmdbId}${epSuffix}`
    : undefined;

  const primaryId = fullImdbId || parsedId.rawId;
  const alternateIds: string[] = [];

  if (fullTmdbPrefixed && fullTmdbPrefixed !== primaryId) {
    alternateIds.push(fullTmdbPrefixed);
  }
  if (parsedId.rawId !== primaryId && !alternateIds.includes(parsedId.rawId)) {
    alternateIds.push(parsedId.rawId);
  }

  const cacheIds = Array.from(
    new Set(
      [primaryId, ...alternateIds, parsedId.rawId].filter(
        (v): v is string => Boolean(v && v.trim()),
      ),
    ),
  );

  return { primaryId, alternateIds, cacheIds };
}

export async function fetchCanonicalMetadata(
  type: string,
  cleanId: string,
  tmdbApiKey?: string,
  cache: MetadataCache = globalMetadataCache,
): Promise<CanonicalMetadata> {
  const effectiveTmdbKey = (tmdbApiKey || process.env.TMDB_API_KEY || '').trim();
  const cacheKey = `${type}:${cleanId}:${effectiveTmdbKey ? 'tmdb' : 'base'}`;

  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const canonicalTitles: string[] = [];
  let year: number | undefined;
  let resolvedImdbId = cleanId.startsWith('tt') ? cleanId : '';
  let resolvedTmdbId = cleanId.startsWith('tmdb:')
    ? cleanId.replace(/^tmdb:/i, '').trim()
    : undefined;

  const cinemetaType = type === 'anime' ? 'series' : type;
  const tasks: Promise<void>[] = [];

  if (cleanId.startsWith('tt')) {
    tasks.push(
      axios
        .get<CinemetaMetaResponse>(
          `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(cinemetaType)}/${encodeURIComponent(cleanId)}.json`,
          {
            timeout: 2800,
            headers: STREMIO_CLIENT_HEADERS,
            httpAgent: sharedHttpAgent,
            httpsAgent: sharedHttpsAgent,
          },
        )
        .then((res) => {
          const meta = res.data?.meta;
          if (!meta) return;
          addUniqueTitle(canonicalTitles, meta.name);
          addUniqueTitle(canonicalTitles, meta.originalName);
          if (Array.isArray(meta.aliases)) {
            for (const alias of meta.aliases) {
              addUniqueTitle(canonicalTitles, alias);
            }
          }
          if (meta.moviedb_id !== undefined && meta.moviedb_id !== null && !resolvedTmdbId) {
            const num = String(meta.moviedb_id).trim();
            if (/^\d+$/.test(num)) resolvedTmdbId = num;
          }
          year = year ?? extractYearFromValue(meta.year) ?? extractYearFromValue(meta.releaseInfo);
        })
        .catch(() => {
          // Cinemeta optional degradation on network failure
        }),
    );

    if (effectiveTmdbKey) {
      tasks.push(
        axios
          .get<TmdbFindResponse>(
            `https://api.themoviedb.org/3/find/${encodeURIComponent(cleanId)}`,
            {
              params: {
                external_source: 'imdb_id',
                language: 'pt-BR',
                api_key: effectiveTmdbKey,
              },
              timeout: 2800,
              httpAgent: sharedHttpAgent,
              httpsAgent: sharedHttpsAgent,
            },
          )
          .then((res) => {
            const movie = res.data?.movie_results?.[0];
            const tv = res.data?.tv_results?.[0];
            if (type === 'movie' && movie) {
              if (movie.id) resolvedTmdbId = String(movie.id);
              addUniqueTitle(canonicalTitles, movie.title);
              addUniqueTitle(canonicalTitles, movie.original_title);
              year = extractYearFromValue(movie.release_date) ?? year;
            } else if ((type === 'series' || type === 'anime') && tv) {
              if (tv.id) resolvedTmdbId = String(tv.id);
              addUniqueTitle(canonicalTitles, tv.name);
              addUniqueTitle(canonicalTitles, tv.original_name);
              year = extractYearFromValue(tv.first_air_date) ?? year;
            } else if (movie) {
              if (movie.id) resolvedTmdbId = String(movie.id);
              addUniqueTitle(canonicalTitles, movie.title);
              addUniqueTitle(canonicalTitles, movie.original_title);
              year = extractYearFromValue(movie.release_date) ?? year;
            } else if (tv) {
              if (tv.id) resolvedTmdbId = String(tv.id);
              addUniqueTitle(canonicalTitles, tv.name);
              addUniqueTitle(canonicalTitles, tv.original_name);
              year = extractYearFromValue(tv.first_air_date) ?? year;
            }
          })
          .catch(() => {
            // TMDB enrichment failure shouldn't block stream aggregation
          }),
      );
    }
  } else if (cleanId.startsWith('tmdb:') && resolvedTmdbId && effectiveTmdbKey) {
    const tmdbEndpointType = type === 'movie' ? 'movie' : 'tv';
    tasks.push(
      axios
        .get<TmdbDirectResponse>(
          `https://api.themoviedb.org/3/${tmdbEndpointType}/${encodeURIComponent(resolvedTmdbId)}`,
          {
            params: {
              language: 'pt-BR',
              append_to_response: 'external_ids',
              api_key: effectiveTmdbKey,
            },
            timeout: 2800,
            httpAgent: sharedHttpAgent,
            httpsAgent: sharedHttpsAgent,
          },
        )
        .then(async (res) => {
          const data = res.data;
          if (!data) return;
          addUniqueTitle(canonicalTitles, data.title);
          addUniqueTitle(canonicalTitles, data.original_title);
          addUniqueTitle(canonicalTitles, data.name);
          addUniqueTitle(canonicalTitles, data.original_name);
          year =
            extractYearFromValue(data.release_date) ??
            extractYearFromValue(data.first_air_date) ??
            year;

          const extImdb = data.external_ids?.imdb_id;
          if (typeof extImdb === 'string' && extImdb.startsWith('tt')) {
            resolvedImdbId = extImdb;
            // Enriquece títulos via Cinemeta se conseguimos o IMDb ID equivalente
            try {
              const cmRes = await axios.get<CinemetaMetaResponse>(
                `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(cinemetaType)}/${encodeURIComponent(extImdb)}.json`,
                {
                  timeout: 2200,
                  headers: STREMIO_CLIENT_HEADERS,
                  httpAgent: sharedHttpAgent,
                  httpsAgent: sharedHttpsAgent,
                },
              );
              const meta = cmRes.data?.meta;
              if (meta) {
                addUniqueTitle(canonicalTitles, meta.name);
                addUniqueTitle(canonicalTitles, meta.originalName);
                if (Array.isArray(meta.aliases)) {
                  for (const alias of meta.aliases) {
                    addUniqueTitle(canonicalTitles, alias);
                  }
                }
                year = year ?? extractYearFromValue(meta.year) ?? extractYearFromValue(meta.releaseInfo);
              }
            } catch {
              // Cinemeta optional
            }
          }
        })
        .catch(() => {
          // Graceful fallback
        }),
    );
  }

  await Promise.allSettled(tasks);

  const result: CanonicalMetadata = {
    imdbId: resolvedImdbId || cleanId,
    tmdbId: resolvedTmdbId,
    type,
    canonicalTitles,
    year,
    fetchedAt: Date.now(),
  };

  if (canonicalTitles.length > 0 || year !== undefined || resolvedTmdbId || resolvedImdbId.startsWith('tt')) {
    cache.set(cacheKey, result);
  }

  return result;
}
