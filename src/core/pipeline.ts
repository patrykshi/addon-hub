import axios from 'axios';
import type { AddonEntry, StreamHubConfig } from './config.ts';
import {
  STREMIO_CLIENT_HEADERS,
  getAddonStreamEndpoint,
  swapPipeEncoding,
} from './config.ts';
import { processStreams } from './matcher.ts';
import type { RawAddonStream, StremioStream } from './matcher.ts';
import {
  buildIdBridgeCandidates,
  fetchCanonicalMetadata,
  parseRequestId,
  type CanonicalMetadata,
} from './metadata.ts';
import {
  StreamCache,
  fetchWithFallback,
  globalAddonWarmer,
  globalStreamCache,
} from './streamCache.ts';

export const HARD_GLOBAL_DEADLINE_MS = 8000;
export const ATTEMPT_TIMEOUT_MS = 3800;

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: string[];
  types: string[];
  idPrefixes: string[];
  behaviorHints: {
    configurable: boolean;
    configurationRequired: boolean;
  };
}

export function buildManifest(): StremioManifest {
  return {
    id: 'org.streamhub.lite',
    version: '1.0.0',
    name: 'StreamHub Lite',
    description:
      'Agregador inteligente de streams com validação anti-erros de metadados para Nuvio e Stremio',
    resources: ['stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'tmdb', 'kitsu'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

interface UpstreamStreamPayload {
  streams?: StremioStream[];
}

export interface AddonFetchDiagnostic {
  name: string;
  url: string;
  endpoint: string;
  ok: boolean;
  rawCount: number;
  durationMs: number;
  fromCache?: boolean;
  usedAltId?: string;
  error?: string;
}

interface AddonFetchOutcome {
  streams: RawAddonStream[];
  diagnostic: AddonFetchDiagnostic;
}

export function parseStreamsPayload(data: unknown): StremioStream[] {
  let resolved: unknown = data;
  if (typeof resolved === 'string') {
    try {
      resolved = JSON.parse(resolved);
    } catch {
      return [];
    }
  }

  if (Array.isArray(resolved)) {
    return resolved as StremioStream[];
  }
  if (resolved && typeof resolved === 'object') {
    const obj = resolved as UpstreamStreamPayload;
    if (Array.isArray(obj.streams)) {
      return obj.streams;
    }
  }
  return [];
}

function formatAxiosFailureReason(error: unknown, timeoutMs: number): string {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ERR_CANCELED') {
      return 'Deadline global atingido';
    }
    if (error.code === 'ECONNABORTED') {
      return `Timeout (${timeoutMs} ms)`;
    }
    if (error.response?.status) {
      return `HTTP ${error.response.status}`;
    }
    if (error.code) {
      return error.code;
    }
    if (error.message) {
      return error.message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Erro de rede';
}

function isRetryableFailure(error: unknown): { retry: boolean; isHttp400Or404: boolean } {
  if (!axios.isAxiosError(error)) {
    return { retry: true, isHttp400Or404: false };
  }
  if (error.code === 'ERR_CANCELED') {
    return { retry: false, isHttp400Or404: false };
  }
  const status = error.response?.status;
  if (status === 400 || status === 404) {
    return { retry: false, isHttp400Or404: true };
  }
  if (status !== undefined) {
    return { retry: status >= 500 || status === 429, isHttp400Or404: false };
  }
  return { retry: true, isHttp400Or404: false };
}

export async function fetchAddonWithRetry(
  url: string,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<{ streams: StremioStream[]; endpointUsed: string; attempts: number; viaProxy: boolean }> {
  const executeSingle = async (
    targetUrl: string,
    timeoutMs: number,
  ): Promise<{ streams: StremioStream[]; viaProxy: boolean }> => {
    const { data, viaProxy } = await fetchWithFallback(targetUrl, timeoutMs, externalSignal);
    return { streams: parseStreamsPayload(data), viaProxy };
  };

  try {
    const { streams, viaProxy } = await executeSingle(url, attemptTimeoutMs);
    return { streams, endpointUsed: url, attempts: 1, viaProxy };
  } catch (firstError) {
    if (externalSignal?.aborted) {
      throw firstError;
    }

    const classification = isRetryableFailure(firstError);
    const swappedUrl = classification.isHttp400Or404 ? swapPipeEncoding(url) : null;

    if (!classification.retry && !swappedUrl) {
      throw firstError;
    }

    const secondUrl = swappedUrl ?? url;
    const { streams, viaProxy } = await executeSingle(secondUrl, attemptTimeoutMs);
    return { streams, endpointUsed: secondUrl, attempts: 2, viaProxy };
  }
}

export interface PipelineResult {
  streams: StremioStream[];
  stats: {
    addonsQueried: number;
    addonsSucceeded: number;
    rawCount: number;
    finalCount: number;
    canonicalTitles: string[];
    canonicalYear?: number;
    imdbId?: string;
    tmdbId?: string;
    deadlineReached: boolean;
    addonResults: AddonFetchDiagnostic[];
  };
}

export async function runStreamPipeline(
  config: StreamHubConfig,
  type: string,
  rawId: string,
  streamCache: StreamCache = globalStreamCache,
): Promise<PipelineResult> {
  const pipelineStartedAt = Date.now();
  const parsedId = parseRequestId(rawId);

  if (config.addons.length === 0) {
    return {
      streams: [],
      stats: {
        addonsQueried: 0,
        addonsSucceeded: 0,
        rawCount: 0,
        finalCount: 0,
        canonicalTitles: [],
        canonicalYear: undefined,
        deadlineReached: false,
        addonResults: [],
      },
    };
  }

  // Camada 5: Aquecimento não-bloqueante para hosts Render / Shardweb
  globalAddonWarmer.warmAddons(config.addons);

  // Trava rígida de tempo: máximo 8000ms no servidor mesmo se config pedir 30000ms
  const safeTimeout = Math.min(Math.max(1000, config.timeoutMs || 6500), HARD_GLOBAL_DEADLINE_MS);
  const globalDeadlineMs = safeTimeout;
  const perAttemptTimeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1000, Math.floor(safeTimeout * 0.5)));

  const deadlineController = new AbortController();
  let deadlineReached = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  // Estágio 1: Resolução de Metadados + Ponte Dupla de IDs (tt <-> tmdb)
  const shouldFetchMetadata =
    config.strictMetaMatch ||
    Boolean(config.tmdbApiKey) ||
    Boolean(process.env.TMDB_API_KEY) ||
    parsedId.cleanId.startsWith('tmdb:') ||
    parsedId.cleanId.startsWith('tt');

  const metadataPromise: Promise<CanonicalMetadata> = shouldFetchMetadata
    ? fetchCanonicalMetadata(type, parsedId.cleanId, config.tmdbApiKey)
    : Promise.resolve({
        imdbId: parsedId.cleanId,
        type,
        canonicalTitles: [],
        year: undefined,
        fetchedAt: Date.now(),
      });

  // Se o ID já veio como tmdb:, aguarda brevemente a ponte tmdb -> tt antes do fan-out principal
  let initialMeta: CanonicalMetadata | null = null;
  if (parsedId.cleanId.startsWith('tmdb:')) {
    initialMeta = await Promise.race([
      metadataPromise,
      new Promise<CanonicalMetadata>((resolve) =>
        setTimeout(
          () =>
            resolve({
              imdbId: parsedId.cleanId,
              tmdbId: parsedId.cleanId.replace(/^tmdb:/i, ''),
              type,
              canonicalTitles: [],
              fetchedAt: Date.now(),
            }),
          2500,
        ),
      ),
    ]);
  }

  const settledOutcomes: Array<AddonFetchOutcome | undefined> = new Array(config.addons.length);

  const buildCacheKeysForAddon = (addonUrl: string, ids: string[]): string[] =>
    ids.map((id) => StreamCache.buildKey(addonUrl, type, id));

  const runAddonTask = async (addon: AddonEntry, index: number): Promise<void> => {
    const addonStartedAt = Date.now();
    const initialBridge = buildIdBridgeCandidates(
      parsedId,
      initialMeta ?? {
        imdbId: parsedId.cleanId,
        type,
        canonicalTitles: [],
        fetchedAt: Date.now(),
      },
    );

    const initialCacheKeys = buildCacheKeysForAddon(addon.url, initialBridge.cacheIds);
    const freshHit = streamCache.getFresh(initialCacheKeys);
    if (freshHit) {
      settledOutcomes[index] = {
        streams: freshHit.streams.map((item) => ({
          addonName: addon.name,
          stream: item.stream,
        })),
        diagnostic: {
          name: addon.name,
          url: addon.url,
          endpoint: getAddonStreamEndpoint(addon.url, type, initialBridge.primaryId),
          ok: true,
          rawCount: freshHit.streams.length,
          durationMs: Date.now() - addonStartedAt,
          fromCache: true,
        },
      };
      return;
    }

    const primaryEndpoint = getAddonStreamEndpoint(addon.url, type, initialBridge.primaryId);
    let lastEndpoint = primaryEndpoint;
    let lastError: string | undefined;

    try {
      const firstResult = await fetchAddonWithRetry(
        primaryEndpoint,
        perAttemptTimeoutMs,
        deadlineController.signal,
      );
      lastEndpoint = firstResult.endpointUsed;

      if (firstResult.streams.length > 0) {
        const mapped = firstResult.streams.map((stream) => ({
          addonName: addon.name,
          stream,
        }));
        const resolvedMeta = initialMeta ?? (await metadataPromise);
        const fullBridge = buildIdBridgeCandidates(parsedId, resolvedMeta);
        streamCache.setSuccess(buildCacheKeysForAddon(addon.url, fullBridge.cacheIds), mapped);

        settledOutcomes[index] = {
          streams: mapped,
          diagnostic: {
            name: addon.name,
            url: addon.url,
            endpoint: lastEndpoint,
            ok: true,
            rawCount: mapped.length,
            durationMs: Date.now() - addonStartedAt,
          },
        };
        return;
      }

      // Se retornou 0 streams no ID primário, tenta o ID alternativo da ponte tt <-> tmdb
      const elapsedSoFar = Date.now() - pipelineStartedAt;
      if (!deadlineController.signal.aborted && elapsedSoFar < globalDeadlineMs - 1000) {
        const resolvedMeta = initialMeta ?? (await metadataPromise);
        const fullBridge = buildIdBridgeCandidates(parsedId, resolvedMeta);
        const allCacheKeys = buildCacheKeysForAddon(addon.url, fullBridge.cacheIds);

        for (const altId of fullBridge.alternateIds) {
          if (altId === initialBridge.primaryId) continue;
          const remainingMs = globalDeadlineMs - (Date.now() - pipelineStartedAt);
          if (remainingMs < 900 || deadlineController.signal.aborted) break;

          const altEndpoint = getAddonStreamEndpoint(addon.url, type, altId);
          lastEndpoint = altEndpoint;
          try {
            const altResult = await fetchAddonWithRetry(
              altEndpoint,
              Math.min(perAttemptTimeoutMs, remainingMs - 200),
              deadlineController.signal,
            );
            lastEndpoint = altResult.endpointUsed;
            if (altResult.streams.length > 0) {
              const mapped = altResult.streams.map((stream) => ({
                addonName: addon.name,
                stream,
              }));
              streamCache.setSuccess(allCacheKeys, mapped);
              settledOutcomes[index] = {
                streams: mapped,
                diagnostic: {
                  name: addon.name,
                  url: addon.url,
                  endpoint: lastEndpoint,
                  ok: true,
                  rawCount: mapped.length,
                  durationMs: Date.now() - addonStartedAt,
                  usedAltId: altId,
                },
              };
              return;
            }
          } catch (altErr) {
            lastError = formatAxiosFailureReason(altErr, perAttemptTimeoutMs);
          }
        }
      }
    } catch (err) {
      lastError = formatAxiosFailureReason(err, perAttemptTimeoutMs);
      console.warn(`[StreamHub Lite] Addon "${addon.name}" (${lastEndpoint}) falhou: ${lastError}`);
    }

    // Regra de Ouro do Cache: NUNCA salvar vazio; tentar fallback de cache stale se existir
    const resolvedMeta = initialMeta ?? (await metadataPromise);
    const fullBridge = buildIdBridgeCandidates(parsedId, resolvedMeta);
    const fallbackHit = streamCache.getFallback(
      buildCacheKeysForAddon(addon.url, fullBridge.cacheIds),
    );

    if (fallbackHit) {
      settledOutcomes[index] = {
        streams: fallbackHit.streams.map((item) => ({
          addonName: addon.name,
          stream: item.stream,
        })),
        diagnostic: {
          name: addon.name,
          url: addon.url,
          endpoint: lastEndpoint,
          ok: true,
          rawCount: fallbackHit.streams.length,
          durationMs: Date.now() - addonStartedAt,
          fromCache: true,
          error: lastError ? `${lastError} (usando cache)` : undefined,
        },
      };
      return;
    }

    settledOutcomes[index] = {
      streams: [],
      diagnostic: {
        name: addon.name,
        url: addon.url,
        endpoint: lastEndpoint,
        ok: !lastError,
        rawCount: 0,
        durationMs: Date.now() - addonStartedAt,
        error: lastError,
      },
    };
  };

  const addonTasks = config.addons.map((addon, idx) => runAddonTask(addon, idx));

  const deadlinePromise = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      deadlineController.abort();
      resolve('deadline');
    }, globalDeadlineMs);
  });

  await Promise.race([Promise.allSettled(addonTasks), deadlinePromise]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  const canonicalMeta =
    initialMeta ??
    (await Promise.race([
      metadataPromise,
      new Promise<CanonicalMetadata>((resolve) =>
        setTimeout(
          () =>
            resolve({
              imdbId: parsedId.cleanId,
              type,
              canonicalTitles: [],
              fetchedAt: Date.now(),
            }),
          300,
        ),
      ),
    ]));

  const fullBridge = buildIdBridgeCandidates(parsedId, canonicalMeta);
  const rawStreams: RawAddonStream[] = [];
  const addonResults: AddonFetchDiagnostic[] = [];
  let addonsSucceeded = 0;

  for (let i = 0; i < config.addons.length; i += 1) {
    const addon = config.addons[i];
    const outcome = settledOutcomes[i];

    if (outcome) {
      addonResults.push(outcome.diagnostic);
      if (outcome.diagnostic.ok) {
        addonsSucceeded += 1;
        rawStreams.push(...outcome.streams);
      }
      continue;
    }

    // Addon não concluiu antes do deadline global de 9500ms -> tenta fallback de cache
    const cacheKeys = buildCacheKeysForAddon(addon.url, fullBridge.cacheIds);
    const fallbackHit = streamCache.getFallback(cacheKeys);
    const endpoint = getAddonStreamEndpoint(addon.url, type, fullBridge.primaryId);

    if (fallbackHit) {
      addonsSucceeded += 1;
      const mapped = fallbackHit.streams.map((item) => ({
        addonName: addon.name,
        stream: item.stream,
      }));
      rawStreams.push(...mapped);
      addonResults.push({
        name: addon.name,
        url: addon.url,
        endpoint,
        ok: true,
        rawCount: mapped.length,
        durationMs: Date.now() - pipelineStartedAt,
        fromCache: true,
        error: `Deadline ${globalDeadlineMs}ms (usando cache)`,
      });
    } else {
      addonResults.push({
        name: addon.name,
        url: addon.url,
        endpoint,
        ok: false,
        rawCount: 0,
        durationMs: Date.now() - pipelineStartedAt,
        error: `Timeout global (${globalDeadlineMs} ms)`,
      });
    }
  }

  // Estágio 3 + Estágio 4
  const streams = processStreams(rawStreams, config, {
    type,
    canonicalMeta,
    reqSeason: parsedId.reqSeason,
    reqEpisode: parsedId.reqEpisode,
  });

  return {
    streams,
    stats: {
      addonsQueried: config.addons.length,
      addonsSucceeded,
      rawCount: rawStreams.length,
      finalCount: streams.length,
      canonicalTitles: canonicalMeta.canonicalTitles,
      canonicalYear: canonicalMeta.year,
      imdbId: canonicalMeta.imdbId,
      tmdbId: canonicalMeta.tmdbId,
      deadlineReached,
      addonResults,
    },
  };
}
