import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { ManifestProbeResult } from './core/probe.ts';

function readConfigFromPathname(pathname: string): {
  encoded: string | null;
  config: StreamHubConfig;
} {
  const match = pathname.match(/^\/([^/]+)\/configure\/?$/);
  if (match && match[1]) {
    const rawSegment = match[1];
    const decoded = decodeConfigBase64Url(rawSegment);
    return { encoded: rawSegment, config: decoded };
  }
  return {
    encoded: null,
    config: {
      ...DEFAULT_CONFIG,
      addons: [],
      resolutions: [...DEFAULT_CONFIG.resolutions],
    },
  };
}

export default function App() {
  const initialState = useMemo(
    () =>
      typeof window !== 'undefined'
        ? readConfigFromPathname(window.location.pathname)
        : { encoded: null, config: DEFAULT_CONFIG },
    [],
  );

  const [config, setConfig] = useState<StreamHubConfig>(initialState.config);
  const [generatedEncoded, setGeneratedEncoded] = useState<string | null>(initialState.encoded);
  const [validationError, setValidationError] = useState('');
  const [probeMap, setProbeMap] = useState<Record<string, AddonProbeState>>({});
  const customNamedUrlsRef = useRef<Set<string>>(new Set());

  const probeAddon = useCallback(async (addonUrl: string, hasCustomName = false) => {
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
      const response = await fetch(`/api/probe-manifest?url=${encodeURIComponent(addonUrl)}`);
      const data = (await response.json()) as ManifestProbeResult;

      setProbeMap((prev) => ({
        ...prev,
        [addonUrl]: {
          status: data.active ? 'active' : 'inactive',
          manifestName: data.name,
          logo: data.logo,
          version: data.version,
          error: data.error,
          latencyMs: data.latencyMs,
        },
      }));

      if (data.active && (data.name || data.logo)) {
        setConfig((prev) => ({
          ...prev,
          addons: prev.addons.map((item) => {
            if (item.url !== addonUrl) return item;
            const shouldAdoptManifestName =
              Boolean(data.name) && !customNamedUrlsRef.current.has(addonUrl);
            return {
              ...item,
              name: shouldAdoptManifestName && data.name ? data.name : item.name,
              logo: data.logo || item.logo,
            };
          }),
        }));
      }
    } catch {
      setProbeMap((prev) => ({
        ...prev,
        [addonUrl]: {
          status: 'inactive',
          error: 'Falha na consulta',
        },
      }));
    }
  }, []);

  // Verifica automaticamente o status, imagem e nome próprio dos addons carregados na URL
  useEffect(() => {
    for (const addon of initialState.config.addons) {
      void probeAddon(addon.url, false);
    }
  }, [initialState.config.addons, probeAddon]);

  useEffect(() => {
    const handlePopState = () => {
      const parsed = readConfigFromPathname(window.location.pathname);
      setConfig(parsed.config);
      setGeneratedEncoded(parsed.encoded);
      setValidationError('');
      for (const addon of parsed.config.addons) {
        void probeAddon(addon.url, false);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [probeAddon]);

  const currentEncoded = useMemo(() => encodeConfigBase64Url(config), [config]);
  const isDirtySinceGenerate = Boolean(generatedEncoded && generatedEncoded !== currentEncoded);

  const handleAddAddon = (addon: AddonEntry, hasCustomName = false) => {
    setValidationError('');
    setConfig((prev) => ({
      ...prev,
      addons: [...prev.addons, addon],
    }));
    void probeAddon(addon.url, hasCustomName);
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
    for (const addon of config.addons) {
      void probeAddon(addon.url, customNamedUrlsRef.current.has(addon.url));
    }
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

    if (typeof window !== 'undefined') {
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
        {/* Cabeçalho editorial limpo */}
        <div className="max-w-3xl">
          <h1 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl [text-wrap:balance]">
            Agregador Stateless para Stremio e Nuvio
          </h1>
          <p className="mt-3 text-base leading-relaxed text-slate-400">
            Unifique seus addons de stream em uma única URL sem banco de dados, com validação estrita de ano, temporada, episódio e título via Cinemeta e TMDB.
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

        {/* Grade principal 2 colunas */}
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
          <div className="space-y-6 lg:col-span-7">
            <AddonManager
              addons={config.addons}
              probeMap={probeMap}
              onAddAddon={handleAddAddon}
              onRemoveAddon={handleRemoveAddon}
              onRefreshAddon={(url) => void probeAddon(url, customNamedUrlsRef.current.has(url))}
              onRefreshAll={handleRefreshAll}
            />
            <FilterSettings config={config} onChange={setConfig} />
          </div>

          <div className="lg:col-span-5">
            <LinkOutputPanel
              encodedConfig={generatedEncoded}
              hasAddons={config.addons.length > 0}
              validationError={validationError}
              onGenerate={handleGenerate}
              isDirtySinceGenerate={isDirtySinceGenerate}
            />
          </div>
        </div>
      </main>

      <footer className="border-t border-white/[0.06] py-6">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 text-xs text-slate-500 sm:px-6">
          <span>StreamHub Lite · Agregador Stateless de Streams</span>
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
