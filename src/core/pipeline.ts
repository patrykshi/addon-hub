import axios from 'axios';
import type { AddonEntry, StreamHubConfig } from './config.ts';
import {
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

export const HARD_GLOBAL_DEADLINE_MS = 8500;
export const ATTEMPT_TIMEOUT_MS = 3800;
const METADATA_MAX_WAIT_MS = 1500;
const RESPONSE_CACHE_TTL_MS = 90_000;
const RESPONSE_CACHE_MAX_ENTRIES = 1000;

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
    return { retry: status >= 500 || status === 429 || status === 403, isHttp400Or404: false };
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

    // Se retornou 200 OK porém com 0 streams e a URL possui pipe (| ou %7C), testa a variante codificada/decodificada
    if (streams.length === 0 && !externalSignal?.aborted) {
      const swappedUrl = swapPipeEncoding(url);
      if (swappedUrl) {
        try {
          const second = await executeSingle(swappedUrl, Math.min(attemptTimeoutMs, 2500));
          if (second.streams.length > 0) {
            return {
              streams: second.streams,
              endpointUsed: swappedUrl,
              attempts: 2,
              viaProxy: second.viaProxy,
            };
          }
        } catch {
          // Mantém resultado original vazio se o swap falhar
        }
      }
    }

    return { streams, endpointUsed: url, attempts: 1, viaProxy };
  } catch (firstError) {
    if (externalSignal?.aborted) {
      throw firstError;
    }

    const classification = isRetryableFailure(firstError);
    const swappedUrl = swapPipeEncoding(url);

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

interface AggregatedCacheEntry {
  result: PipelineResult;
  cachedAt: number;
}

const aggregatedResponseCache = new Map<string, AggregatedCacheEntry>();
const inFlightPipelines = new Map<string, Promise<PipelineResult>>();

function buildPipelineFlightKey(config: StreamHubConfig, type: string, cleanRawId: string): string {
  const addonsSig = config.addons.map((a) => `${a.url}|${a.name}`).join(';');
  const resSig = config.resolutions.join(',');
  return [
    type,
    cleanRawId,
    addonsSig,
    resSig,
    config.allowUnknownRes ? '1' : '0',
    config.languageMode,
    config.strictMetaMatch ? '1' : '0',
    String(config.timeoutMs),
    config.tmdbApiKey ? 'k' : '',
  ].join('::');
}

export function clearPipelineResponseCache(): void {
  aggregatedResponseCache.clear();
}

export async function runStreamPipeline(
  config: StreamHubConfig,
  type: string,
  rawId: string,
  streamCache: StreamCache = globalStreamCache,
): Promise<PipelineResult> {
  const cleanRawId = rawId.replace(/\.json$/i, '');

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

  const useGlobalCoalescing = streamCache === globalStreamCache;
  const flightKey = useGlobalCoalescing
    ? buildPipelineFlightKey(config, type, cleanRawId)
    : '';

  if (useGlobalCoalescing) {
    const cached = aggregatedResponseCache.get(flightKey);
    if (cached && Date.now() - cached.cachedAt <= RESPONSE_CACHE_TTL_MS) {
      return cached.result;
    }
    const existingFlight = inFlightPipelines.get(flightKey);
    if (existingFlight) {
      return existingFlight;
    }
  }

  const executePipeline = async (): Promise<PipelineResult> => {
    const pipelineStartedAt = Date.now();
    const parsedId = parseRequestId(cleanRawId);

    // Camada 5: Aquecimento não-bloqueante
    globalAddonWarmer.warmAddons(config.addons);

    // Trava rígida de tempo para não estourar o timeout nativo do Stremio/Nuvio
    const safeTimeout = Math.min(Math.max(1500, config.timeoutMs || 6500), HARD_GLOBAL_DEADLINE_MS);
    const globalDeadlineMs = safeTimeout;
    const perAttemptTimeoutMs = Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1500, Math.floor(safeTimeout * 0.5)));

    const deadlineController = new AbortController();
    let deadlineReached = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const fallbackEmptyMeta: CanonicalMetadata = {
      imdbId: parsedId.cleanId,
      tmdbId: parsedId.cleanId.startsWith('tmdb:') ? parsedId.cleanId.replace(/^tmdb:/i, '') : undefined,
      type,
      canonicalTitles: [],
      year: undefined,
      fetchedAt: Date.now(),
    };

    // Estágio 1: Resolução de Metadados protegida por timeout curto (nunca trava os addons)
    const shouldFetchMetadata =
      config.strictMetaMatch ||
      Boolean(config.tmdbApiKey) ||
      Boolean(process.env.TMDB_API_KEY) ||
      parsedId.cleanId.startsWith('tmdb:') ||
      parsedId.cleanId.startsWith('tt');

    const safeMetadataPromise: Promise<CanonicalMetadata> = shouldFetchMetadata
      ? Promise.race([
          fetchCanonicalMetadata(type, parsedId.cleanId, config.tmdbApiKey).catch(() => fallbackEmptyMeta),
          new Promise<CanonicalMetadata>((resolve) =>
            setTimeout(() => resolve(fallbackEmptyMeta), METADATA_MAX_WAIT_MS),
          ),
        ])
      : Promise.resolve(fallbackEmptyMeta);

    // Se o ID veio como tmdb:, aguarda até 900ms pela ponte tmdb -> tt antes de disparar os addons
    let resolvedMeta: CanonicalMetadata | null = null;
    if (parsedId.cleanId.startsWith('tmdb:')) {
      resolvedMeta = await Promise.race([
        safeMetadataPromise,
        new Promise<CanonicalMetadata>((resolve) =>
          setTimeout(() => resolve(fallbackEmptyMeta), 900),
        ),
      ]);
    }

  const settledOutcomes: Array<AddonFetchOutcome | undefined> = new Array(config.addons.length);

  const buildCacheKeysForAddon = (addonUrl: string, ids: string[]): string[] =>
    ids.map((id) => StreamCache.buildKey(addonUrl, type, id));

  const runAddonTask = async (addon: AddonEntry, index: number): Promise<void> => {
    const addonStartedAt = Date.now();
    const initialBridge = buildIdBridgeCandidates(parsedId, resolvedMeta ?? fallbackEmptyMeta);

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
    let primaryUrlUsed = primaryEndpoint;
    let primarySucceededEmpty = false;
    let lastError: string | undefined;

    try {
      const firstResult = await fetchAddonWithRetry(
        primaryEndpoint,
        perAttemptTimeoutMs,
        deadlineController.signal,
      );
      lastEndpoint = firstResult.endpointUsed;
      primaryUrlUsed = firstResult.endpointUsed;

      if (firstResult.streams.length > 0) {
        const mapped = firstResult.streams.map((stream) => ({
          addonName: addon.name,
          stream,
        }));
        // Grava imediatamente no cache sem bloquear aguardando metadados externos
        streamCache.setSuccess(buildCacheKeysForAddon(addon.url, initialBridge.cacheIds), mapped);
        void safeMetadataPromise.then((currentMeta) => {
          const fullBridge = buildIdBridgeCandidates(parsedId, currentMeta);
          streamCache.setSuccess(buildCacheKeysForAddon(addon.url, fullBridge.cacheIds), mapped);
        });

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

      primarySucceededEmpty = true;
    } catch (err) {
      lastError = formatAxiosFailureReason(err, perAttemptTimeoutMs);
    }

    // Se retornou 0 streams OU falhou no ID primário, tenta imediatamente os IDs alternativos (tt <-> tmdb)
    const elapsedSoFar = Date.now() - pipelineStartedAt;
    if (!deadlineController.signal.aborted && elapsedSoFar < globalDeadlineMs - 800) {
      const currentMeta = resolvedMeta ?? (await safeMetadataPromise);
      const fullBridge = buildIdBridgeCandidates(parsedId, currentMeta);
      const allCacheKeys = buildCacheKeysForAddon(addon.url, fullBridge.cacheIds);

      for (const altId of fullBridge.alternateIds) {
        if (altId === initialBridge.primaryId) continue;
        const remainingMs = globalDeadlineMs - (Date.now() - pipelineStartedAt);
        if (remainingMs < 700 || deadlineController.signal.aborted) break;

        const altEndpoint = getAddonStreamEndpoint(addon.url, type, altId);
        lastEndpoint = altEndpoint;
        try {
          const altResult = await fetchAddonWithRetry(
            altEndpoint,
            Math.min(perAttemptTimeoutMs, remainingMs - 150),
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
          if (!primarySucceededEmpty) {
            lastError = formatAxiosFailureReason(altErr, perAttemptTimeoutMs);
          }
        }
      }
    }

    // Fallback de Cache (Stale) caso o addon tenha oscilado
    const currentMeta = resolvedMeta ?? (await safeMetadataPromise);
    const fullBridge = buildIdBridgeCandidates(parsedId, currentMeta);
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
          endpoint: primarySucceededEmpty ? primaryUrlUsed : lastEndpoint,
          ok: true,
          rawCount: fallbackHit.streams.length,
          durationMs: Date.now() - addonStartedAt,
          fromCache: true,
          error: !primarySucceededEmpty && lastError ? `${lastError} (usando cache)` : undefined,
        },
      };
      return;
    }

    if (primarySucceededEmpty) {
      settledOutcomes[index] = {
        streams: [],
        diagnostic: {
          name: addon.name,
          url: addon.url,
          endpoint: primaryUrlUsed,
          ok: true,
          rawCount: 0,
          durationMs: Date.now() - addonStartedAt,
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

  const canonicalMeta = await safeMetadataPromise;
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

  // Estágio 3 + Estágio 4: Filtragem e Ordenação
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
  };

  if (!useGlobalCoalescing) {
    return executePipeline();
  }

  const flightPromise = executePipeline()
    .then((result) => {
      if (result.streams.length > 0) {
        if (aggregatedResponseCache.size >= RESPONSE_CACHE_MAX_ENTRIES && !aggregatedResponseCache.has(flightKey)) {
          const oldest = aggregatedResponseCache.keys().next().value;
          if (oldest) aggregatedResponseCache.delete(oldest);
        }
        aggregatedResponseCache.set(flightKey, { result, cachedAt: Date.now() });
      }
      return result;
    })
    .finally(() => {
      inFlightPipelines.delete(flightKey);
    });

  inFlightPipelines.set(flightKey, flightPromise);
  return flightPromise;
}