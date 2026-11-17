import axios from 'axios';
import { normalizeManifestUrl } from './config.ts';
import { fetchWithFallback } from './streamCache.ts';

export interface ManifestProbeResult {
  url: string;
  active: boolean;
  name?: string;
  logo?: string;
  version?: string;
  description?: string;
  error?: string;
  latencyMs: number;
}

export interface ParsedManifestMetadata {
  valid: boolean;
  name?: string;
  logo?: string;
  version?: string;
  description?: string;
}

function resolveLogoUrl(rawLogo: unknown, manifestUrl: string): string | undefined {
  if (typeof rawLogo !== 'string') return undefined;
  const trimmed = rawLogo.trim();
  if (!trimmed) return undefined;

  try {
    const resolved = new URL(trimmed, manifestUrl);
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
      return resolved.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function parseUpstreamManifest(
  raw: unknown,
  manifestUrl: string,
): ParsedManifestMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false };
  }

  const obj = raw as Record<string, unknown>;
  const hasId = typeof obj.id === 'string' && obj.id.trim().length > 0;
  const hasName = typeof obj.name === 'string' && obj.name.trim().length > 0;
  const hasResources = Array.isArray(obj.resources) && obj.resources.length > 0;

  if (!hasId && !hasName && !hasResources) {
    return { valid: false };
  }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined;
  const logo = resolveLogoUrl(obj.logo ?? obj.icon, manifestUrl);
  const version =
    typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined;
  const description =
    typeof obj.description === 'string' && obj.description.trim()
      ? obj.description.trim()
      : undefined;

  return {
    valid: true,
    name,
    logo,
    version,
    description,
  };
}

const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
const probeResultCache = new Map<string, { result: ManifestProbeResult; cachedAt: number }>();
const inFlightProbes = new Map<string, Promise<ManifestProbeResult>>();

function getCachedProbe(normalizedUrl: string, now = Date.now()): ManifestProbeResult | undefined {
  const entry = probeResultCache.get(normalizedUrl);
  if (!entry) return undefined;
  if (now - entry.cachedAt > PROBE_CACHE_TTL_MS) {
    probeResultCache.delete(normalizedUrl);
    return undefined;
  }
  return entry.result;
}

function setCachedProbe(normalizedUrl: string, result: ManifestProbeResult, now = Date.now()): void {
  if (probeResultCache.size >= 500 && !probeResultCache.has(normalizedUrl)) {
    const oldest = probeResultCache.keys().next().value;
    if (oldest) probeResultCache.delete(oldest);
  }
  probeResultCache.set(normalizedUrl, { result, cachedAt: now });
}

export async function probeAddonManifest(
  rawUrl: string,
  timeoutMs = 5000,
  forceRefresh = false,
): Promise<ManifestProbeResult> {
  const startedAt = Date.now();
  let normalizedUrl: string;

  try {
    normalizedUrl = normalizeManifestUrl(rawUrl);
  } catch (err) {
    return {
      url: rawUrl,
      active: false,
      error: err instanceof Error ? err.message : 'URL inválida',
      latencyMs: Date.now() - startedAt,
    };
  }

  if (!forceRefresh) {
    const cached = getCachedProbe(normalizedUrl);
    if (cached) {
      return cached;
    }
    const existing = inFlightProbes.get(normalizedUrl);
    if (existing) {
      return existing;
    }
  }

  const probePromise = (async (): Promise<ManifestProbeResult> => {
    try {
      const { data } = await fetchWithFallback(normalizedUrl, timeoutMs);

      let payload = data;
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = null;
        }
      }

      const parsed = parseUpstreamManifest(payload, normalizedUrl);
      const latencyMs = Date.now() - startedAt;

      if (!parsed.valid) {
        return {
          url: normalizedUrl,
          active: false,
          error: 'Manifesto Stremio inválido',
          latencyMs,
        };
      }

      const okResult: ManifestProbeResult = {
        url: normalizedUrl,
        active: true,
        name: parsed.name,
        logo: parsed.logo,
        version: parsed.version,
        description: parsed.description,
        latencyMs,
      };
      setCachedProbe(normalizedUrl, okResult);
      return okResult;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      let errorMessage = 'Inacessível';

      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          errorMessage = 'Timeout';
        } else if (error.response?.status) {
          errorMessage = `HTTP ${error.response.status}`;
        } else if (error.code) {
          errorMessage = error.code;
        }
      }

      return {
        url: normalizedUrl,
        active: false,
        error: errorMessage,
        latencyMs,
      };
    } finally {
      inFlightProbes.delete(normalizedUrl);
    }
  })();

  if (!forceRefresh) {
    inFlightProbes.set(normalizedUrl, probePromise);
  }
  return probePromise;
}

export async function probeManyAddonManifests(
  urls: string[],
  timeoutMs = 5000,
  forceRefresh = false,
): Promise<ManifestProbeResult[]> {
  const uniqueUrls = Array.from(
    new Set(urls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)),
  ).slice(0, 40);

  return Promise.all(
    uniqueUrls.map((url) => probeAddonManifest(url, timeoutMs, forceRefresh)),
  );
}
