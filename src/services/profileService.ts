import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { sanitizeConfig, type StreamHubConfig } from '../core/config.ts';
import { OperationType, db, handleFirestoreError } from '../firebase.ts';

export interface SavedProfile {
  id: string;
  ownerId: string;
  name: string;
  config: StreamHubConfig;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UserAccountDoc {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  defaultProfileId?: string;
}

const PROFILE_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export function generateProfileId(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let id = 'prf_';
  for (let i = 0; i < 22; i += 1) {
    id += PROFILE_ID_CHARS[bytes[i] % PROFILE_ID_CHARS.length];
  }
  return id;
}

function clampString(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function toMillis(ts: unknown): number {
  if (ts && typeof ts === 'object' && typeof (ts as Timestamp).toMillis === 'function') {
    return (ts as Timestamp).toMillis();
  }
  return Date.now();
}

function buildSanitizedProfilePayload(name: string, config: StreamHubConfig) {
  const sanitized = sanitizeConfig(config);
  const cleanName = clampString(name, 60) || 'Perfil Principal';

  // Respeita estritamente limites do firebase-blueprint.json (max 40 addons, URL <= 2048, nome <= 64)
  const boundedAddons = sanitized.addons.slice(0, 40).map((addon) => {
    const entry: { url: string; name: string; logo?: string } = {
      url: clampString(addon.url, 2048),
      name: clampString(addon.name || 'Addon', 64) || 'Addon',
    };
    if (addon.logo && /^https?:\/\//i.test(addon.logo)) {
      entry.logo = clampString(addon.logo, 2048);
    }
    return entry;
  });

  return {
    name: cleanName,
    addons: boundedAddons,
    resolutions: sanitized.resolutions.slice(0, 4),
    allowUnknownRes: Boolean(sanitized.allowUnknownRes),
    languageMode: sanitized.languageMode,
    strictMetaMatch: Boolean(sanitized.strictMetaMatch),
    timeoutMs: Math.min(30000, Math.max(1000, Math.round(sanitized.timeoutMs || 6500))),
    tmdbApiKey: clampString(sanitized.tmdbApiKey || '', 128),
  };
}

export async function ensureUserAccountDoc(user: User): Promise<UserAccountDoc> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  const cleanEmail = clampString(user.email || `${user.uid}@user.local`, 320);
  const cleanName = clampString(user.displayName || cleanEmail.split('@')[0] || 'Usuário', 100);
  const cleanPhoto = user.photoURL ? clampString(user.photoURL, 500) : undefined;

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const payload: Record<string, unknown> = {
        uid: user.uid,
        email: cleanEmail,
        displayName: cleanName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (cleanPhoto) {
        payload.photoURL = cleanPhoto;
      }
      await setDoc(ref, payload);
      return {
        uid: user.uid,
        email: cleanEmail,
        displayName: cleanName,
        photoURL: cleanPhoto,
      };
    }

    const existing = snap.data() as Record<string, unknown>;
    const updatePayload: Record<string, unknown> = {
      email: cleanEmail,
      displayName: cleanName,
      updatedAt: serverTimestamp(),
    };
    if (cleanPhoto) {
      updatePayload.photoURL = cleanPhoto;
    }
    await updateDoc(ref, updatePayload);
    return {
      uid: user.uid,
      email: cleanEmail,
      displayName: cleanName,
      photoURL: cleanPhoto,
      defaultProfileId:
        typeof existing.defaultProfileId === 'string' ? existing.defaultProfileId : undefined,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadUserTmdbSecret(uid: string): Promise<string> {
  const path = `users/${uid}/secrets/tmdb`;
  try {
    const snap = await getDoc(doc(db, 'users', uid, 'secrets', 'tmdb'));
    if (!snap.exists()) return '';
    const data = snap.data() as { tmdbApiKey?: unknown };
    return typeof data.tmdbApiKey === 'string' ? data.tmdbApiKey : '';
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveUserTmdbSecret(uid: string, tmdbApiKey: string): Promise<void> {
  const path = `users/${uid}/secrets/tmdb`;
  const cleanKey = clampString(tmdbApiKey, 128);
  const ref = doc(db, 'users', uid, 'secrets', 'tmdb');

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerId: uid,
        tmdbApiKey: cleanKey,
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        tmdbApiKey: cleanKey,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeUserProfiles(
  uid: string,
  onProfiles: (profiles: SavedProfile[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const path = 'profiles';
  const q = query(collection(db, path), where('ownerId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: SavedProfile[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const cfg = sanitizeConfig({
          addons: data.addons,
          resolutions: data.resolutions,
          allowUnknownRes: data.allowUnknownRes,
          languageMode: data.languageMode,
          strictMetaMatch: data.strictMetaMatch,
          timeoutMs: data.timeoutMs,
        });

        return {
          id: docSnap.id,
          ownerId: typeof data.ownerId === 'string' ? data.ownerId : uid,
          name: typeof data.name === 'string' ? data.name : 'Perfil salvo',
          config: cfg,
          createdAtMs: toMillis(data.createdAt),
          updatedAtMs: toMillis(data.updatedAt),
        };
      });

      items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      onProfiles(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        if (onError && wrapped instanceof Error) {
          onError(wrapped);
        }
      }
    },
  );
}

export async function fetchSingleProfile(profileId: string): Promise<SavedProfile | null> {
  const path = `profiles/${profileId}`;
  try {
    const snap = await getDoc(doc(db, 'profiles', profileId));
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, unknown>;
    return {
      id: snap.id,
      ownerId: typeof data.ownerId === 'string' ? data.ownerId : '',
      name: typeof data.name === 'string' ? data.name : 'Perfil salvo',
      config: sanitizeConfig({
        addons: data.addons,
        resolutions: data.resolutions,
        allowUnknownRes: data.allowUnknownRes,
        languageMode: data.languageMode,
        strictMetaMatch: data.strictMetaMatch,
        timeoutMs: data.timeoutMs,
      }),
      createdAtMs: toMillis(data.createdAt),
      updatedAtMs: toMillis(data.updatedAt),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

async function invalidateServerProfileCache(profileId: string): Promise<void> {
  try {
    await fetch('/api/profile-cache/invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
  } catch {
    // Melhor esforço; cache tem TTL curto de 60s
  }
}

export async function saveCloudProfile(
  uid: string,
  existingProfileId: string | null,
  name: string,
  config: StreamHubConfig,
  setAsDefault = false,
): Promise<string> {
  const sanitizedPayload = buildSanitizedProfilePayload(name, config);
  const { tmdbApiKey, ...publicProfileData } = sanitizedPayload;

  const isUpdate = Boolean(existingProfileId);
  const targetId = existingProfileId || generateProfileId();
  const path = `profiles/${targetId}`;
  const ref = doc(db, 'profiles', targetId);

  try {
    if (isUpdate) {
      await updateDoc(ref, {
        ...publicProfileData,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        ownerId: uid,
        ...publicProfileData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(
      error,
      isUpdate ? OperationType.UPDATE : OperationType.CREATE,
      path,
    );
  }

  if (tmdbApiKey) {
    await saveUserTmdbSecret(uid, tmdbApiKey);
  }

  if (setAsDefault) {
    await setDefaultCloudProfile(uid, targetId);
  }

  await invalidateServerProfileCache(targetId);
  return targetId;
}

export async function setDefaultCloudProfile(uid: string, profileId: string): Promise<void> {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      defaultProfileId: profileId,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteCloudProfile(profileId: string): Promise<void> {
  const path = `profiles/${profileId}`;
  try {
    await deleteDoc(doc(db, 'profiles', profileId));
    await invalidateServerProfileCache(profileId);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
