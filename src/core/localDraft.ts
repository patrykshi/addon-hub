import { DEFAULT_CONFIG, sanitizeConfig, type StreamHubConfig } from './config.ts';

export const LOCAL_DRAFT_STORAGE_KEY = 'streamhub_lite_draft_v1';

export interface LocalDraftPayload {
  config: StreamHubConfig;
  activeProfileId?: string;
  activeProfileName?: string;
  updatedAt: number;
}

export function serializeLocalDraft(
  config: StreamHubConfig,
  activeProfileId?: string | null,
  activeProfileName?: string | null,
): string {
  const sanitized = sanitizeConfig(config);
  const payload: LocalDraftPayload = {
    config: sanitized,
    activeProfileId: activeProfileId || undefined,
    activeProfileName: activeProfileName || undefined,
    updatedAt: Date.now(),
  };
  return JSON.stringify(payload);
}

export function parseLocalDraft(rawJson: string | null | undefined): LocalDraftPayload | null {
  if (!rawJson || typeof rawJson !== 'string') return null;
  try {
    const parsed = JSON.parse(rawJson) as Partial<LocalDraftPayload>;
    if (!parsed || typeof parsed !== 'object' || !parsed.config) {
      return null;
    }
    return {
      config: sanitizeConfig(parsed.config),
      activeProfileId:
        typeof parsed.activeProfileId === 'string' && parsed.activeProfileId.trim()
          ? parsed.activeProfileId.trim()
          : undefined,
      activeProfileName:
        typeof parsed.activeProfileName === 'string' && parsed.activeProfileName.trim()
          ? parsed.activeProfileName.trim()
          : undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveLocalDraft(
  config: StreamHubConfig,
  activeProfileId?: string | null,
  activeProfileName?: string | null,
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      LOCAL_DRAFT_STORAGE_KEY,
      serializeLocalDraft(config, activeProfileId, activeProfileName),
    );
  } catch {
    // Ignora falha de cota do localStorage
  }
}

export function loadLocalDraft(): LocalDraftPayload {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {
      config: { ...DEFAULT_CONFIG, addons: [], resolutions: [...DEFAULT_CONFIG.resolutions] },
      updatedAt: 0,
    };
  }
  try {
    const parsed = parseLocalDraft(window.localStorage.getItem(LOCAL_DRAFT_STORAGE_KEY));
    if (parsed) return parsed;
  } catch {
    // Fallback seguro
  }
  return {
    config: { ...DEFAULT_CONFIG, addons: [], resolutions: [...DEFAULT_CONFIG.resolutions] },
    updatedAt: 0,
  };
}
