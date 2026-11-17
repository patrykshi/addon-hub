import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountProfilesBar } from './components/AccountProfilesBar.tsx';
import { AddonManager, type AddonProbeState } from './components/AddonManager.tsx';
import { FilterSettings } from './components/FilterSettings.tsx';
import { LinkOutputPanel } from './components/LinkOutputPanel.tsx';
import { TopBar } from './components/TopBar.tsx';
import {
  DEFAULT_CONFIG,
  decodeConfigBase64Url,
  encodeConfigBase64Url,
  type AddonEntry,
  type StreamHubConfig,
} from './core/config.ts';
import { loadLocalDraft, saveLocalDraft } from './core/localDraft.ts';
import type { ManifestProbeResult } from './core/probe.ts';
import { auth, googleProvider } from './firebase.ts';
import {
  deleteCloudProfile,
  ensureUserAccountDoc,
  fetchSingleProfile,
  loadUserTmdbSecret,
  saveCloudProfile,
  setDefaultCloudProfile,
  subscribeUserProfiles,
  type SavedProfile,
} from './services/profileService.ts';

interface InitialRouteState {
  encoded: string | null;
  profileIdFromUrl: string | null;
  config: StreamHubConfig;
  profileNameFromDraft?: string;
  loadedFromUrl: boolean;
}

function readInitialStateFromLocation(pathname: string): InitialRouteState {
  const profileMatch = pathname.match(/^\/p\/([^/]+)\/configure\/?$/);
  if (profileMatch && profileMatch[1]) {
    const draft = loadLocalDraft();
    return {
      encoded: null,
      profileIdFromUrl: profileMatch[1],
      config:
        draft.activeProfileId === profileMatch[1]
          ? draft.config
          : { ...DEFAULT_CONFIG, addons: [], resolutions: [...DEFAULT_CONFIG.resolutions] },
      profileNameFromDraft:
        draft.activeProfileId === profileMatch[1] ? draft.activeProfileName : undefined,
      loadedFromUrl: true,
    };
  }

  const base64Match = pathname.match(/^\/([^/]+)\/configure\/?$/);
  if (base64Match && base64Match[1] && base64Match[1] !== 'configure') {
    const rawSegment = base64Match[1];
    const decoded = decodeConfigBase64Url(rawSegment);
    return {
      encoded: rawSegment,
      profileIdFromUrl: null,
      config: decoded,
      loadedFromUrl: true,
    };
  }

  const draft = loadLocalDraft();
  return {
    encoded: null,
    profileIdFromUrl: draft.activeProfileId || null,
    config: draft.config,
    profileNameFromDraft: draft.activeProfileName,
    loadedFromUrl: false,
  };
}

export default function App() {
  const initialState = useMemo(
    () =>
      typeof window !== 'undefined'
        ? readInitialStateFromLocation(window.location.pathname)
        : {
            encoded: null,
            profileIdFromUrl: null,
            config: DEFAULT_CONFIG,
            loadedFromUrl: false,
          },
    [],
  );

  const [config, setConfig] = useState<StreamHubConfig>(initialState.config);
  const [generatedEncoded, setGeneratedEncoded] = useState<string | null>(initialState.encoded);
  const [validationError, setValidationError] = useState('');
  const [probeMap, setProbeMap] = useState<Record<string, AddonProbeState>>({});
  const customNamedUrlsRef = useRef<Set<string>>(new Set());

  // Estado de Usuário & Perfis na Nuvem (Firebase Auth + Firestore)
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [profiles, setProfiles] = useState<SavedProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(
    initialState.profileIdFromUrl,
  );
  const [defaultProfileId, setDefaultProfileId] = useState<string | undefined>(undefined);
  const [profileNameInput, setProfileNameInput] = useState(
    initialState.profileNameFromDraft || 'Principal Nuvio + Stremio',
  );
  const [savingProfile, setSavingProfile] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');
  const [saveError, setSaveError] = useState('');
  const [userTmdbSecret, setUserTmdbSecret] = useState('');

  const applyProbeResults = useCallback((results: ManifestProbeResult[]) => {
    setProbeMap((prev) => {
      const next = { ...prev };
      for (const data of results) {
        next[data.url] = {
          status: data.active ? 'active' : 'inactive',
          manifestName: data.name,
          logo: data.logo,
          version: data.version,
          error: data.error,
          latencyMs: data.latencyMs,
        };
      }
      return next;
    });

    const activeByUrl = new Map<string, ManifestProbeResult>();
    for (const item of results) {
      if (item.active && (item.name || item.logo)) {
        activeByUrl.set(item.url, item);
      }
    }

    if (activeByUrl.size > 0) {
      setConfig((prev) => ({
        ...prev,
        addons: prev.addons.map((item) => {
          const hit = activeByUrl.get(item.url);
          if (!hit) return item;
          const shouldAdoptManifestName =
            Boolean(hit.name) && !customNamedUrlsRef.current.has(item.url);
          return {
            ...item,
            name: shouldAdoptManifestName && hit.name ? hit.name : item.name,
            logo: hit.logo || item.logo,
          };
        }),
      }));
    }
  }, []);

  const probeAddonsBatch = useCallback(
    async (urls: string[], force = false) => {
      const cleanUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
      if (cleanUrls.length === 0) return;

      setProbeMap((prev) => {
        const next = { ...prev };
        for (const u of cleanUrls) {
          next[u] = {
            status: 'checking',
            manifestName: prev[u]?.manifestName,
            logo: prev[u]?.logo,
            version: prev[u]?.version,
          };
        }
        return next;
      });

      try {
        const response = await fetch('/api/probe-manifests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: cleanUrls, force }),
        });
        const payload = (await response.json()) as { results?: ManifestProbeResult[] };
        if (Array.isArray(payload.results)) {
          applyProbeResults(payload.results);
        }
      } catch {
        setProbeMap((prev) => {
          const next = { ...prev };
          for (const u of cleanUrls) {
            next[u] = { status: 'inactive', error: 'Falha na consulta' };
          }
          return next;
        });
      }
    },
    [applyProbeResults],
  );

  const probeAddon = useCallback(
    async (addonUrl: string, hasCustomName = false, force = false) => {
      if (hasCustomName) {
        customNamedUrlsRef.current.add(addonUrl);
      }

      setProbeMap((prev) => ({
        ...prev,
        [addonUrl]: {
          status: 'checking',
          manifestName: prev[addonUrl]?.manifestName,
          logo: prev[addonUrl]?.logo,
          version: prev[addonUrl]?.version,
        },
      }));

      try {
        const response = await fetch(
          `/api/probe-manifest?url=${encodeURIComponent(addonUrl)}${force ? '&force=1' : ''}`,
        );
        const data = (await response.json()) as ManifestProbeResult;
        applyProbeResults([data]);
      } catch {
        setProbeMap((prev) => ({
          ...prev,
          [addonUrl]: {
            status: 'inactive',
            error: 'Falha na consulta',
          },
        }));
      }
    },
    [applyProbeResults],
  );

  // Persiste rascunho local instantaneamente para evitar perda entre recarregamentos
  useEffect(() => {
    saveLocalDraft(config, activeProfileId, profileNameInput);
  }, [config, activeProfileId, profileNameInput]);

  // Se acessou /p/:profileId/configure diretamente, carrega do Firestore
  useEffect(() => {
    if (!initialState.profileIdFromUrl || !initialState.loadedFromUrl) return;
    let cancelled = false;
    void fetchSingleProfile(initialState.profileIdFromUrl)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        setConfig((prev) => ({
          ...loaded.config,
          tmdbApiKey: prev.tmdbApiKey || userTmdbSecret || '',
        }));
        setActiveProfileId(loaded.id);
        setProfileNameInput(loaded.name);
        void probeAddonsBatch(loaded.config.addons.map((a) => a.url));
      })
      .catch(() => {
        // Perfil inacessível ou inexistente
      });
    return () => {
      cancelled = true;
    };
  }, [initialState.loadedFromUrl, initialState.profileIdFromUrl, probeAddonsBatch, userTmdbSecret]);

  // Verifica status/imagem/nome dos addons iniciais em uma única requisição em lote
  useEffect(() => {
    if (initialState.config.addons.length > 0) {
      void probeAddonsBatch(initialState.config.addons.map((a) => a.url));
    }
  }, [initialState.config.addons, probeAddonsBatch]);

  // Sincronização Firebase Auth + Perfis Salvos
  useEffect(() => {
    let unsubscribeProfiles: (() => void) | undefined;

    const unsubscribeAuth = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
      setAuthError('');

      if (unsubscribeProfiles) {
        unsubscribeProfiles();
        unsubscribeProfiles = undefined;
      }

      if (!nextUser) {
        setProfiles([]);
        setDefaultProfileId(undefined);
        return;
      }

      try {
        const account = await ensureUserAccountDoc(nextUser);
        setDefaultProfileId(account.defaultProfileId);

        const savedTmdb = await loadUserTmdbSecret(nextUser.uid);
        if (savedTmdb) {
          setUserTmdbSecret(savedTmdb);
          setConfig((prev) => (prev.tmdbApiKey ? prev : { ...prev, tmdbApiKey: savedTmdb }));
        }

        let didAutoLoadDefault = false;
        unsubscribeProfiles = subscribeUserProfiles(
          nextUser.uid,
          (list) => {
            setProfiles(list);
            if (
              !didAutoLoadDefault &&
              !initialState.loadedFromUrl &&
              initialState.config.addons.length === 0 &&
              list.length > 0
            ) {
              didAutoLoadDefault = true;
              const target =
                list.find((p) => p.id === account.defaultProfileId) || list[0];
              setConfig({
                ...target.config,
                tmdbApiKey: savedTmdb || '',
              });
              setActiveProfileId(target.id);
              setProfileNameInput(target.name);
              void probeAddonsBatch(target.config.addons.map((a) => a.url));
            }
          },
          (err) => {
            setSaveError(err.message);
          },
        );
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Erro ao sincronizar conta com Firestore.',
        );
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfiles) unsubscribeProfiles();
    };
  }, [initialState.config.addons.length, initialState.loadedFromUrl, probeAddonsBatch]);

  useEffect(() => {
    const handlePopState = () => {
      const parsed = readInitialStateFromLocation(window.location.pathname);
      setConfig(parsed.config);
      setGeneratedEncoded(parsed.encoded);
      setActiveProfileId(parsed.profileIdFromUrl);
      setValidationError('');
      if (parsed.config.addons.length > 0) {
        void probeAddonsBatch(parsed.config.addons.map((a) => a.url));
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [probeAddonsBatch]);

  const currentEncoded = useMemo(() => encodeConfigBase64Url(config), [config]);
  const isDirtySinceGenerate = Boolean(generatedEncoded && generatedEncoded !== currentEncoded);

  const activeSavedProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) || null,
    [profiles, activeProfileId],
  );

  const hasUnsavedProfileChanges = useMemo(() => {
    if (!activeSavedProfile) return false;
    const savedEncoded = encodeConfigBase64Url({
      ...activeSavedProfile.config,
      tmdbApiKey: config.tmdbApiKey,
    });
    return savedEncoded !== currentEncoded || activeSavedProfile.name !== profileNameInput.trim();
  }, [activeSavedProfile, config.tmdbApiKey, currentEncoded, profileNameInput]);

  const handleSignIn = async () => {
    setAuthError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'Não foi possível concluir o login com Google.',
      );
    }
  };

  const handleSignOut = async () => {
    setAuthError('');
    try {
      await signOut(auth);
      setSaveFeedback('');
      setSaveError('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Erro ao sair da conta.');
    }
  };

  const handleSaveProfile = async (asNew: boolean) => {
    if (!user) return;
    if (config.addons.length === 0) {
      setSaveError('Adicione pelo menos um addon antes de salvar um perfil.');
      return;
    }

    setSavingProfile(true);
    setSaveError('');
    setSaveFeedback('');

    try {
      const targetProfileId = asNew ? null : activeProfileId;
      const shouldSetDefault = !defaultProfileId || asNew === false;
      const savedId = await saveCloudProfile(
        user.uid,
        targetProfileId,
        profileNameInput || 'Principal Nuvio + Stremio',
        config,
        shouldSetDefault,
      );
      setActiveProfileId(savedId);
      if (shouldSetDefault) {
        setDefaultProfileId(savedId);
      }
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/p/${savedId}/configure`);
      }
      setSaveFeedback(
        asNew
          ? 'Novo perfil salvo na nuvem com link permanente.'
          : 'Perfil atualizado na nuvem. O link no Nuvio/Stremio já reflete as alterações.',
      );
      window.setTimeout(() => setSaveFeedback(''), 4000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Erro ao salvar perfil no Firestore.',
      );
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSelectProfile = (profile: SavedProfile) => {
    setSaveError('');
    setSaveFeedback('');
    setValidationError('');
    setActiveProfileId(profile.id);
    setProfileNameInput(profile.name);
    setConfig({
      ...profile.config,
      tmdbApiKey: config.tmdbApiKey || userTmdbSecret || '',
    });
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/p/${profile.id}/configure`);
    }
    void probeAddonsBatch(profile.config.addons.map((a) => a.url));
  };

  const handleSetDefaultProfile = async (profileId: string) => {
    if (!user) return;
    setSaveError('');
    try {
      await setDefaultCloudProfile(user.uid, profileId);
      setDefaultProfileId(profileId);
      setSaveFeedback('Perfil padrão atualizado.');
      window.setTimeout(() => setSaveFeedback(''), 3000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Não foi possível definir o perfil padrão.',
      );
    }
  };

  const handleDeleteProfile = async (profile: SavedProfile) => {
    setSaveError('');
    try {
      await deleteCloudProfile(profile.id);
      if (activeProfileId === profile.id) {
        setActiveProfileId(null);
        setProfileNameInput('Novo Perfil');
        if (typeof window !== 'undefined') {
          window.history.replaceState(null, '', '/configure');
        }
      }
      setSaveFeedback(`Perfil "${profile.name}" excluído.`);
      window.setTimeout(() => setSaveFeedback(''), 3000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Erro ao excluir perfil.',
      );
    }
  };

  const handleStartNewDraft = () => {
    setActiveProfileId(null);
    setProfileNameInput('Novo Perfil');
    setSaveFeedback('');
    setSaveError('');
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/configure');
    }
  };

  const handleAddAddon = (addon: AddonEntry, hasCustomName = false) => {
    setValidationError('');
    setConfig((prev) => ({
      ...prev,
      addons: [...prev.addons, addon],
    }));
    void probeAddon(addon.url, hasCustomName);
  };

  const handleUpdateAddon = (oldUrl: string, updated: AddonEntry, hasCustomName = false) => {
    setValidationError('');
    const urlChanged = oldUrl !== updated.url;
    const keepCustomName =
      hasCustomName || (!urlChanged && customNamedUrlsRef.current.has(oldUrl));

    if (urlChanged) {
      customNamedUrlsRef.current.delete(oldUrl);
    }
    if (keepCustomName) {
      customNamedUrlsRef.current.add(updated.url);
    } else {
      customNamedUrlsRef.current.delete(updated.url);
    }

    setConfig((prev) => ({
      ...prev,
      addons: prev.addons.map((item) => (item.url === oldUrl ? updated : item)),
    }));

    if (urlChanged) {
      setProbeMap((prev) => {
        const next = { ...prev };
        delete next[oldUrl];
        return next;
      });
      void probeAddon(updated.url, keepCustomName);
    }
  };

  const handleRemoveAddon = (url: string) => {
    customNamedUrlsRef.current.delete(url);
    setConfig((prev) => ({
      ...prev,
      addons: prev.addons.filter((item) => item.url !== url),
    }));
    setProbeMap((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
  };

  const handleRefreshAll = () => {
    void probeAddonsBatch(
      config.addons.map((a) => a.url),
      true,
    );
  };

  const handleGenerate = () => {
    if (config.addons.length === 0) {
      setValidationError('Adicione pelo menos um addon upstream antes de gerar o link.');
      const outputEl = document.getElementById('saida');
      outputEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    setValidationError('');
    const encoded = encodeConfigBase64Url(config);
    setGeneratedEncoded(encoded);

    if (typeof window !== 'undefined' && !activeProfileId) {
      window.history.replaceState(null, '', `/${encoded}/configure`);
    }
  };

  const languageSummary =
    config.languageMode === 'only_ptbr'
      ? 'Apenas PT-BR'
      : config.languageMode === 'prioritize_ptbr'
        ? 'PT-BR prioritário'
        : 'Todos os idiomas';

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <TopBar onGenerateClick={handleGenerate} />

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="max-w-3xl">
          <h1 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl [text-wrap:balance]">
            Agregador Inteligente para Stremio e Nuvio
          </h1>
          <p className="mt-3 text-base leading-relaxed text-slate-400">
            Unifique seus addons de stream em alta velocidade, salve perfis na sua conta para nunca perder configurações em atualizações e valide ano, temporada, episódio e título via Cinemeta e TMDB.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-400 tabular-nums">
            <span>{config.addons.length} {config.addons.length === 1 ? 'addon' : 'addons'}</span>
            <span aria-hidden="true">·</span>
            <span>{config.strictMetaMatch ? 'Anti-Mismatch ativo' : 'Anti-Mismatch desativado'}</span>
            <span aria-hidden="true">·</span>
            <span>{languageSummary}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">Timeout {config.timeoutMs} ms</span>
          </div>
        </div>

        <div className="mt-7">
          <AccountProfilesBar
            user={user}
            authLoading={authLoading}
            authError={authError}
            profiles={profiles}
            activeProfileId={activeProfileId}
            defaultProfileId={defaultProfileId}
            profileNameInput={profileNameInput}
            savingProfile={savingProfile}
            saveFeedback={saveFeedback}
            saveError={saveError}
            hasAddons={config.addons.length > 0}
            onProfileNameChange={setProfileNameInput}
            onSignIn={() => void handleSignIn()}
            onSignOut={() => void handleSignOut()}
            onSaveProfile={(asNew) => void handleSaveProfile(asNew)}
            onSelectProfile={handleSelectProfile}
            onSetDefaultProfile={(id) => void handleSetDefaultProfile(id)}
            onDeleteProfile={(profile) => void handleDeleteProfile(profile)}
            onStartNewDraft={handleStartNewDraft}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
          <div className="space-y-6 lg:col-span-7">
            <AddonManager
              addons={config.addons}
              probeMap={probeMap}
              onAddAddon={handleAddAddon}
              onUpdateAddon={handleUpdateAddon}
              onRemoveAddon={handleRemoveAddon}
              onRefreshAddon={(url) => void probeAddon(url, customNamedUrlsRef.current.has(url), true)}
              onRefreshAll={handleRefreshAll}
            />
            <FilterSettings config={config} onChange={setConfig} />
          </div>

          <div className="lg:col-span-5">
            <LinkOutputPanel
              encodedConfig={generatedEncoded}
              activeProfileId={activeProfileId}
              activeProfileName={activeSavedProfile?.name || profileNameInput}
              hasAddons={config.addons.length > 0}
              validationError={validationError}
              onGenerate={handleGenerate}
              isDirtySinceGenerate={isDirtySinceGenerate}
              hasUnsavedProfileChanges={hasUnsavedProfileChanges}
            />
          </div>
        </div>
      </main>

      <footer className="border-t border-white/[0.06] py-6">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:px-6">
          <span>StreamHub Lite · Agregador de Streams</span>
          <a
            href="/manifest.json"
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:text-slate-300 transition-colors"
          >
            /manifest.json
          </a>
        </div>
      </footer>
    </div>
  );
}
