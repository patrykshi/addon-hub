export type ResolutionKey = '2160p' | '1080p' | '720p' | '480p';

export type LanguageMode = 'prioritize_ptbr' | 'only_ptbr' | 'none';

export interface AddonEntry {
  url: string;
  name: string;
  logo?: string;
}

export interface StreamHubConfig {
  addons: AddonEntry[];
  resolutions: ResolutionKey[];
  allowUnknownRes: boolean;
  languageMode: LanguageMode;
  strictMetaMatch: boolean;
  timeoutMs: number;
  tmdbApiKey?: string;
}

export interface AddonPreset {
  id: string;
  name: string;
  url: string;
  summary: string;
}

export const ALL_RESOLUTIONS: ResolutionKey[] = ['2160p', '1080p', '720p', '480p'];

export const DEFAULT_CONFIG: StreamHubConfig = {
  addons: [],
  resolutions: ['2160p', '1080p', '720p', '480p'],
  allowUnknownRes: true,
  languageMode: 'prioritize_ptbr',
  strictMetaMatch: true,
  timeoutMs: 6500,
  tmdbApiKey: '',
};

export const ADDON_PRESETS: AddonPreset[] = [
  {
    id: 'torrentio',
    name: 'Torrentio',
    url: 'https://torrentio.strem.fun/manifest.json',
    summary: 'Torrents P2P e Debrid públicos',
  },
  {
    id: 'comet',
    name: 'Comet',
    url: 'https://comet.elfhosted.com/manifest.json',
    summary: 'Agregador rápido compatível com Debrid',
  },
  {
    id: 'mediafusion',
    name: 'MediaFusion',
    url: 'https://mediafusion.elfhosted.com/manifest.json',
    summary: 'Streams multi-fonte e catálogos de vídeo',
  },
  {
    id: 'nuviostreams',
    name: 'NuvioStreams',
    url: 'https://nuviostreams.hayd.uk/manifest.json',
    summary: 'Links HTTP diretos otimizados para Nuvio',
  },
];

export function extractAddonDisplayName(url: string, explicitName?: string): string {
  const trimmed = explicitName?.trim();
  if (trimmed) return trimmed;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('torrentio')) return 'Torrentio';
    if (host.includes('comet')) return 'Comet';
    if (host.includes('mediafusion')) return 'MediaFusion';
    if (host.includes('nuvio')) return 'NuvioStreams';
    if (host.includes('knightcrawler')) return 'KnightCrawler';
    if (host.includes('annatar')) return 'Annatar';
    if (host.includes('jackettio')) return 'Jackettio';
    if (host.includes('stremthru')) return 'StremThru';

    const firstLabel = host.split('.')[0] || 'Addon';
    return firstLabel.charAt(0).toUpperCase() + firstLabel.slice(1);
  } catch {
    return 'Addon';
  }
}

export function normalizeManifestUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL do addon vazia.');
  }

  const httpConverted = trimmed.replace(/^stremio:\/\//i, 'https://');
  let parsed: URL;
  try {
    parsed = new URL(httpConverted);
  } catch {
    throw new Error('URL inválida. Informe uma URL completa começando com https:// ou stremio://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protocolo não suportado. Use http://, https:// ou stremio://');
  }

  // Preserva a codificação original do caminho de configuração (ex: | ou %7C)
  const qIndex = httpConverted.indexOf('?');
  const basePart = qIndex >= 0 ? httpConverted.slice(0, qIndex) : httpConverted;
  const queryPart = qIndex >= 0 ? httpConverted.slice(qIndex) : '';
  const cleanBase = basePart.replace(/\/+$/, '');
  const withManifest = /\/manifest\.json$/i.test(cleanBase)
    ? cleanBase
    : `${cleanBase}/manifest.json`;

  return `${withManifest}${queryPart}`;
}

export const STREMIO_CLIENT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
} as const;

export function getAddonStreamEndpoint(manifestUrl: string, type: string, id: string): string {
  const normalized = normalizeManifestUrl(manifestUrl);
  const qIndex = normalized.indexOf('?');
  const baseWithoutQuery = qIndex >= 0 ? normalized.slice(0, qIndex) : normalized;
  const querySuffix = qIndex >= 0 ? normalized.slice(qIndex) : '';
  const cleanBaseUrl = baseWithoutQuery.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  return `${cleanBaseUrl}/stream/${encodeURIComponent(type)}/${id}.json${querySuffix}`;
}

export function swapPipeEncoding(url: string): string | null {
  const streamIdx = url.indexOf('/stream/');
  const prefix = streamIdx >= 0 ? url.slice(0, streamIdx) : url;
  const suffix = streamIdx >= 0 ? url.slice(streamIdx) : '';

  if (prefix.includes('%7C') || prefix.includes('%7c')) {
    return `${prefix.replace(/%7C/gi, '|')}${suffix}`;
  }
  if (prefix.includes('|')) {
    return `${prefix.replace(/\|/g, '%7C')}${suffix}`;
  }
  return null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(encoded: string): Uint8Array {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  const padded = base64 + '='.repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function sanitizeConfig(input: Partial<StreamHubConfig> | unknown): StreamHubConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const rawAddons = Array.isArray(raw.addons) ? raw.addons : [];
  const seenUrls = new Set<string>();
  const addons: AddonEntry[] = [];

  for (const item of rawAddons) {
    let candidateUrl = '';
    let candidateName: string | undefined;
    let candidateLogo: string | undefined;

    if (typeof item === 'string') {
      candidateUrl = item;
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      if (typeof obj.url === 'string') candidateUrl = obj.url;
      if (typeof obj.name === 'string') candidateName = obj.name;
      if (typeof obj.logo === 'string') {
        const trimmedLogo = obj.logo.trim();
        if (/^https?:\/\//i.test(trimmedLogo)) {
          candidateLogo = trimmedLogo;
        }
      }
    }

    if (!candidateUrl.trim()) continue;
    try {
      const normalized = normalizeManifestUrl(candidateUrl);
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      const entry: AddonEntry = {
        url: normalized,
        name: extractAddonDisplayName(normalized, candidateName),
      };
      if (candidateLogo) {
        entry.logo = candidateLogo;
      }
      addons.push(entry);
    } catch {
      // Ignore malformed addon URL during config sanitization
    }
  }

  const validResSet = new Set<ResolutionKey>(ALL_RESOLUTIONS);
  const resolutions: ResolutionKey[] = Array.isArray(raw.resolutions)
    ? raw.resolutions.filter((r): r is ResolutionKey => typeof r === 'string' && validResSet.has(r as ResolutionKey))
    : [...DEFAULT_CONFIG.resolutions];

  const allowUnknownRes =
    typeof raw.allowUnknownRes === 'boolean' ? raw.allowUnknownRes : DEFAULT_CONFIG.allowUnknownRes;

  const languageMode: LanguageMode =
    raw.languageMode === 'prioritize_ptbr' ||
    raw.languageMode === 'only_ptbr' ||
    raw.languageMode === 'none'
      ? raw.languageMode
      : DEFAULT_CONFIG.languageMode;

  const strictMetaMatch =
    typeof raw.strictMetaMatch === 'boolean' ? raw.strictMetaMatch : DEFAULT_CONFIG.strictMetaMatch;

  const parsedTimeout =
    typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? Math.round(raw.timeoutMs)
      : DEFAULT_CONFIG.timeoutMs;
  const timeoutMs = Math.min(30000, Math.max(1000, parsedTimeout));

  const tmdbApiKey = typeof raw.tmdbApiKey === 'string' ? raw.tmdbApiKey.trim() : '';

  return {
    addons,
    resolutions,
    allowUnknownRes,
    languageMode,
    strictMetaMatch,
    timeoutMs,
    tmdbApiKey,
  };
}

export function encodeConfigBase64Url(config: StreamHubConfig): string {
  const sanitized = sanitizeConfig(config);
  const compact: Record<string, unknown> = {
    addons: sanitized.addons,
    resolutions: sanitized.resolutions,
    allowUnknownRes: sanitized.allowUnknownRes,
    languageMode: sanitized.languageMode,
    strictMetaMatch: sanitized.strictMetaMatch,
    timeoutMs: sanitized.timeoutMs,
  };
  if (sanitized.tmdbApiKey) {
    compact.tmdbApiKey = sanitized.tmdbApiKey;
  }
  const json = JSON.stringify(compact);
  const bytes = new TextEncoder().encode(json);
  return bytesToBase64Url(bytes);
}

export function decodeConfigBase64Url(encoded?: string): StreamHubConfig {
  if (!encoded || !encoded.trim()) {
    return { ...DEFAULT_CONFIG, addons: [], resolutions: [...DEFAULT_CONFIG.resolutions] };
  }

  try {
    const bytes = base64UrlToBytes(encoded.trim());
    const json = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(json);
    return sanitizeConfig(parsed);
  } catch {
    return { ...DEFAULT_CONFIG, addons: [], resolutions: [...DEFAULT_CONFIG.resolutions] };
  }
}
