import axios from 'axios';
import { sanitizeConfig, type StreamHubConfig } from './config.ts';
import { sharedHttpsAgent } from './streamCache.ts';

export interface FirebaseClientConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

interface FirestoreValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string | number;
  doubleValue?: number;
  arrayValue?: {
    values?: FirestoreValue[];
  };
  mapValue?: {
    fields?: Record<string, FirestoreValue>;
  };
}

interface FirestoreDocumentResponse {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}

const VALID_PROFILE_ID_RE = /^[a-zA-Z0-9_-]{20,64}$/;

export function isValidProfileId(profileId: string): boolean {
  return VALID_PROFILE_ID_RE.test(profileId);
}

function readString(field?: FirestoreValue): string | undefined {
  return typeof field?.stringValue === 'string' ? field.stringValue : undefined;
}

function readBoolean(field?: FirestoreValue): boolean | undefined {
  return typeof field?.booleanValue === 'boolean' ? field.booleanValue : undefined;
}

function readNumber(field?: FirestoreValue): number | undefined {
  if (typeof field?.integerValue === 'number' && Number.isFinite(field.integerValue)) {
    return field.integerValue;
  }
  if (typeof field?.integerValue === 'string' && field.integerValue.trim() !== '') {
    const parsed = Number.parseInt(field.integerValue, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof field?.doubleValue === 'number' && Number.isFinite(field.doubleValue)) {
    return field.doubleValue;
  }
  return undefined;
}

export function parseFirestoreProfileDoc(
  doc: unknown,
): { name: string; config: StreamHubConfig } | null {
  if (!doc || typeof doc !== 'object') return null;
  const typed = doc as FirestoreDocumentResponse;
  const fields = typed.fields;
  if (!fields || typeof fields !== 'object') return null;

  const profileName = readString(fields.name) || 'Perfil salvo';

  const rawAddons: Array<{ url: string; name?: string; logo?: string }> = [];
  const addonValues = fields.addons?.arrayValue?.values;
  if (Array.isArray(addonValues)) {
    for (const entry of addonValues) {
      const mapFields = entry.mapValue?.fields;
      if (!mapFields) continue;
      const url = readString(mapFields.url);
      if (!url) continue;
      const name = readString(mapFields.name);
      const logo = readString(mapFields.logo);
      rawAddons.push({ url, name, logo });
    }
  }

  const rawResolutions: string[] = [];
  const resValues = fields.resolutions?.arrayValue?.values;
  if (Array.isArray(resValues)) {
    for (const entry of resValues) {
      const val = readString(entry);
      if (val) rawResolutions.push(val);
    }
  }

  const config = sanitizeConfig({
    addons: rawAddons,
    resolutions: rawResolutions,
    allowUnknownRes: readBoolean(fields.allowUnknownRes),
    languageMode: readString(fields.languageMode),
    strictMetaMatch: readBoolean(fields.strictMetaMatch),
    timeoutMs: readNumber(fields.timeoutMs),
  });

  return { name: profileName, config };
}

interface ProfileCacheEntry {
  config: StreamHubConfig;
  fetchedAt: number;
}

export class ProfileCache {
  private readonly store = new Map<string, ProfileCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = 60_000, maxEntries = 500) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(profileId: string, now = Date.now()): StreamHubConfig | undefined {
    const entry = this.store.get(profileId);
    if (!entry) return undefined;
    if (now - entry.fetchedAt > this.ttlMs) {
      this.store.delete(profileId);
      return undefined;
    }
    return entry.config;
  }

  set(profileId: string, config: StreamHubConfig, now = Date.now()): void {
    if (this.store.size >= this.maxEntries && !this.store.has(profileId)) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(profileId, { config, fetchedAt: now });
  }

  invalidate(profileId: string): void {
    this.store.delete(profileId);
  }

  clear(): void {
    this.store.clear();
  }
}

export const globalProfileCache = new ProfileCache();
const inFlightProfileLoads = new Map<string, Promise<StreamHubConfig | null>>();

export async function fetchProfileConfigFromFirestore(
  profileId: string,
  firebaseCfg: FirebaseClientConfig | null,
  cache: ProfileCache = globalProfileCache,
): Promise<StreamHubConfig | null> {
  if (!firebaseCfg || !isValidProfileId(profileId)) {
    return null;
  }

  const cached = cache.get(profileId);
  if (cached) {
    return cached;
  }

  const existingPromise = inFlightProfileLoads.get(profileId);
  if (existingPromise) {
    return existingPromise;
  }

  const loadPromise = (async (): Promise<StreamHubConfig | null> => {
    try {
      const url =
        `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseCfg.projectId)}` +
        `/databases/${encodeURIComponent(firebaseCfg.firestoreDatabaseId)}` +
        `/documents/profiles/${encodeURIComponent(profileId)}?key=${encodeURIComponent(firebaseCfg.apiKey)}`;

      const response = await axios.get<FirestoreDocumentResponse>(url, {
        timeout: 2500,
        httpsAgent: sharedHttpsAgent,
      });

      const parsed = parseFirestoreProfileDoc(response.data);
      if (!parsed) return null;
      cache.set(profileId, parsed.config);
      return parsed.config;
    } catch {
      return null;
    } finally {
      inFlightProfileLoads.delete(profileId);
    }
  })();

  inFlightProfileLoads.set(profileId, loadPromise);
  return loadPromise;
}
