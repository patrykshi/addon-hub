import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { STREMIO_CLIENT_HEADERS, type AddonEntry } from './config.ts';
import type { RawAddonStream } from './matcher.ts';

export const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
});

export const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
  maxSockets: 64,
});

export type ProxyUrlBuilder = (targetUrl: string) => string;

export const DEFAULT_CORS_PROXIES: ProxyUrlBuilder[] = [
  (targetUrl: string) => `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`,
  (targetUrl: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
];

function isLocalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1'
    );
  } catch {
    return false;
  }
}

function shouldTryProxyFallback(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (
    error.code === 'ERR_CANCELED' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ETIMEDOUT'
  ) {
    // NUNCA acionar proxy se o servidor original deu timeout (evita multiplicar o tempo por 3x)
    return false;
  }
  const status = error.response?.status;
  // Aciona proxy apenas em bloqueios de WAF/Cloudflare/Rate-Limit ou erro de TLS/Conexão rápida
  if (status === undefined) {
    return error.code === 'ECONNRESET' || error.code === 'EPROTO';
  }
  return status === 403 || status === 503 || status === 429;
}

function isValidStremioPayload(data: unknown, targetUrl = ''): boolean {
  if (!data) return false;
  const isManifestRequest = /\/manifest\.json(?:$|\?)/i.test(targetUrl);

  let resolved: unknown = data;
  if (typeof resolved === 'string') {
    const trimmed = resolved.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      resolved = JSON.parse(trimmed);
    } catch {
      return false;
    }
  }

  if (Array.isArray(resolved)) return true;
  if (resolved && typeof resolved === 'object') {
    const obj = resolved as { streams?: unknown; id?: unknown; name?: unknown; resources?: unknown };
    if (Array.isArray(obj.streams)) return true;
    if (
      isManifestRequest &&
      (typeof obj.id === 'string' || typeof obj.name === 'string' || Array.isArray(obj.resources))
    ) {
      return true;
    }
  }
  return false;
}

export async function fetchWithFallback(
  url: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  proxyBuilders: ProxyUrlBuilder[] = DEFAULT_CORS_PROXIES,
): Promise<{ data: unknown; viaProxy: boolean }> {
  try {
    const response = await axios.get<unknown>(url, {
      timeout: timeoutMs,
      signal: externalSignal,
      headers: STREMIO_CLIENT_HEADERS,
      httpAgent: sharedHttpAgent,
      httpsAgent: sharedHttpsAgent,
    });
    return { data: response.data, viaProxy: false };
  } catch (directError) {
    if (externalSignal?.aborted || !shouldTryProxyFallback(directError)) {
      throw directError;
    }

    const usingDefaultProxies = proxyBuilders === DEFAULT_CORS_PROXIES;
    if (usingDefaultProxies && isLocalUrl(url)) {
      throw directError;
    }

    const proxyTimeoutMs = Math.min(timeoutMs, 2600);

    for (const buildProxyUrl of proxyBuilders) {
      if (externalSignal?.aborted) break;
      try {
        const proxyUrl = buildProxyUrl(url);
        const proxyResponse = await axios.get<unknown>(proxyUrl, {
          timeout: proxyTimeoutMs,
          signal: externalSignal,
          headers: STREMIO_CLIENT_HEADERS,
          httpAgent: sharedHttpAgent,
          httpsAgent: sharedHttpsAgent,
        });
        if (isValidStremioPayload(proxyResponse.data, url)) {
          return { data: proxyResponse.data, viaProxy: true };
        }
      } catch {
        // Tenta o próximo proxy
      }
    }

    throw directError;
  }
}

export interface StreamCacheEntry {
  streams: RawAddonStream[];
  cachedAt: number;
}

const STREAM_CACHE_FRESH_TTL_MS = 20 * 60 * 1000; // 20 minutos
const STREAM_CACHE_MAX_STALE_MS = 12 * 60 * 60 * 1000; // 12 horas para fallback de emergência

export class StreamCache {
  private readonly store = new Map<string, StreamCacheEntry>();
  private readonly freshTtlMs: number;
  private readonly maxStaleMs: number;

  constructor(
    freshTtlMs = STREAM_CACHE_FRESH_TTL_MS,
    maxStaleMs = STREAM_CACHE_MAX_STALE_MS,
  ) {
    this.freshTtlMs = freshTtlMs;
    this.maxStaleMs = maxStaleMs;
  }

  static buildKey(addonUrl: string, type: string, mediaId: string): string {
    return `${addonUrl}-${type}-${mediaId}`;
  }

  setSuccess(keys: string[], streams: RawAddonStream[], now = Date.now()): void {
    if (!Array.isArray(streams) || streams.length === 0) return;

    for (const key of keys) {
      if (!key) continue;
      if (this.store.size >= 3000 && !this.store.has(key)) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey) this.store.delete(oldestKey);
      }
      this.store.set(key, {
        streams,
        cachedAt: now,
      });
    }
  }

  getFresh(keys: string[], now = Date.now()): StreamCacheEntry | undefined {
    for (const key of keys) {
      const entry = this.store.get(key);
      if (!entry) continue;
      if (now - entry.cachedAt <= this.freshTtlMs) {
        return entry;
      }
    }
    return undefined;
  }

  getFallback(keys: string[], now = Date.now()): StreamCacheEntry | undefined {
    for (const key of keys) {
      const entry = this.store.get(key);
      if (!entry) continue;
      if (now - entry.cachedAt <= this.maxStaleMs) {
        return entry;
      }
      this.store.delete(key);
    }
    return undefined;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export const globalStreamCache = new StreamCache();

const WARMUP_HOST_SUBSTRINGS = ['onrender.com', 'shardweb.app', 'duckdns.org', 'fenixhub.online'];
const WARMUP_THROTTLE_MS = 4 * 60 * 1000;
const WARMUP_TRACK_TTL_MS = 2 * 60 * 60 * 1000;

export class AddonWarmer {
  private readonly lastPingAt = new Map<string, number>();
  private readonly trackedAddons = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  isColdStartHost(url: string): boolean {
    const lower = url.toLowerCase();
    return WARMUP_HOST_SUBSTRINGS.some((host) => lower.includes(host));
  }

  startBackgroundLoop(intervalMs = 8 * 60 * 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [url, seenAt] of this.trackedAddons.entries()) {
        if (now - seenAt > WARMUP_TRACK_TTL_MS) {
          this.trackedAddons.delete(url);
          continue;
        }
        void this.pingAddon(url);
      }
    }, intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private async pingAddon(url: string): Promise<void> {
    const now = Date.now();
    const last = this.lastPingAt.get(url) ?? 0;
    if (now - last < WARMUP_THROTTLE_MS) return;

    this.lastPingAt.set(url, now);
    try {
      await axios.get(url, {
        timeout: 4500,
        headers: STREMIO_CLIENT_HEADERS,
        httpAgent: sharedHttpAgent,
        httpsAgent: sharedHttpsAgent,
      });
    } catch {
      // Ping de aquecimento silencioso
    }
  }

  warmAddons(addons: AddonEntry[]): void {
    if (!Array.isArray(addons) || addons.length === 0) return;
    const now = Date.now();

    for (const addon of addons) {
      if (!addon?.url || !this.isColdStartHost(addon.url)) continue;
      if (this.trackedAddons.size >= 100 && !this.trackedAddons.has(addon.url)) {
        const oldest = this.trackedAddons.keys().next().value;
        if (oldest) this.trackedAddons.delete(oldest);
      }
      this.trackedAddons.set(addon.url, now);
      void this.pingAddon(addon.url);
    }
  }
}

export const globalAddonWarmer = new AddonWarmer();
globalAddonWarmer.startBackgroundLoop();