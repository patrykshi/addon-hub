import React, { useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  ADDON_PRESETS,
  extractAddonDisplayName,
  normalizeManifestUrl,
  type AddonEntry,
  type AddonPreset,
} from '../core/config.ts';

export interface AddonProbeState {
  status: 'checking' | 'active' | 'inactive';
  manifestName?: string;
  logo?: string;
  version?: string;
  error?: string;
  latencyMs?: number;
}

interface AddonManagerProps {
  addons: AddonEntry[];
  probeMap: Record<string, AddonProbeState>;
  onAddAddon: (addon: AddonEntry, hasCustomName?: boolean) => void;
  onRemoveAddon: (url: string) => void;
  onRefreshAddon: (url: string) => void;
  onRefreshAll: () => void;
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'AD';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export const AddonManager: React.FC<AddonManagerProps> = ({
  addons,
  probeMap,
  onAddAddon,
  onRemoveAddon,
  onRefreshAddon,
  onRefreshAll,
}) => {
  const [urlInput, setUrlInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [brokenLogos, setBrokenLogos] = useState<Record<string, boolean>>({});

  const isPresetAdded = (presetUrl: string): boolean => {
    try {
      const normPreset = normalizeManifestUrl(presetUrl);
      return addons.some((a) => a.url === normPreset);
    } catch {
      return false;
    }
  };

  const handleAddPreset = (preset: AddonPreset) => {
    setErrorMessage('');
    const normalized = normalizeManifestUrl(preset.url);
    if (addons.some((a) => a.url === normalized)) {
      return;
    }
    onAddAddon(
      {
        url: normalized,
        name: preset.name,
      },
      false,
    );
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage('');

    try {
      const normalized = normalizeManifestUrl(urlInput);
      if (addons.some((a) => a.url === normalized)) {
        setErrorMessage('Este addon já está na sua lista.');
        return;
      }
      const trimmedCustomName = nameInput.trim();
      const displayName = extractAddonDisplayName(normalized, trimmedCustomName);
      onAddAddon(
        {
          url: normalized,
          name: displayName,
        },
        Boolean(trimmedCustomName),
      );
      setUrlInput('');
      setNameInput('');
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Informe uma URL válida de manifest.json.',
      );
    }
  };

  const anyChecking = addons.some((a) => probeMap[a.url]?.status === 'checking');

  return (
    <section
      id="addons"
      aria-labelledby="addons-heading"
      className="rounded-xl border border-white/[0.08] bg-[#111723] p-5 sm:p-6"
    >
      <div className="border-b border-white/[0.07] pb-4">
        <div className="flex items-center justify-between gap-4">
          <h2 id="addons-heading" className="text-lg font-semibold text-white">
            01. Addons Upstream
          </h2>
          <div className="flex items-center gap-3 shrink-0">
            {addons.length > 0 && (
              <button
                type="button"
                onClick={onRefreshAll}
                disabled={anyChecking}
                className="flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 disabled:opacity-50 cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${anyChecking ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>Reverificar</span>
              </button>
            )}
            <span className="font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
              {addons.length} {addons.length === 1 ? 'adicionado' : 'adicionados'}
            </span>
          </div>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Adicione as URLs de manifest.json para verificar disponibilidade, imagem e nome próprio de cada addon.
        </p>
      </div>

      {/* Presets populares */}
      <div className="mt-5">
        <p className="text-xs font-medium text-slate-400 mb-2.5">
          Atalhos rápidos
        </p>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {ADDON_PRESETS.map((preset) => {
            const added = isPresetAdded(preset.url);
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleAddPreset(preset)}
                disabled={added}
                title={preset.summary}
                className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  added
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 cursor-default'
                    : 'border-white/[0.09] bg-[#161E2E] text-slate-200 hover:border-blue-500/50 hover:bg-[#1B2538] hover:text-white'
                }`}
              >
                {added ? (
                  <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4 shrink-0 text-blue-400" aria-hidden="true" />
                )}
                <span>{preset.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Formulário manual */}
      <form onSubmit={handleSubmit} className="mt-5 space-y-3" noValidate>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
          <div className="sm:col-span-7">
            <label htmlFor="addon-url-input" className="block text-xs font-medium text-slate-300 mb-1.5">
              URL do manifest.json
            </label>
            <input
              id="addon-url-input"
              type="url"
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                if (errorMessage) setErrorMessage('');
              }}
              placeholder="https://torrentio.strem.fun/manifest.json"
              className="w-full min-h-[44px] rounded-lg border border-white/[0.1] bg-[#0B0F17] px-3.5 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="sm:col-span-3">
            <label htmlFor="addon-name-input" className="block text-xs font-medium text-slate-300 mb-1.5">
              Nome (opcional)
            </label>
            <input
              id="addon-name-input"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Ex: Torrentio"
              maxLength={32}
              className="w-full min-h-[44px] rounded-lg border border-white/[0.1] bg-[#0B0F17] px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="sm:col-span-2 flex items-end">
            <button
              type="submit"
              className="w-full min-h-[44px] rounded-lg border border-blue-500/40 bg-blue-600/15 px-4 py-2 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 whitespace-nowrap cursor-pointer"
            >
              Adicionar
            </button>
          </div>
        </div>

        {errorMessage && (
          <p role="alert" className="text-xs font-medium text-red-400">
            {errorMessage}
          </p>
        )}
      </form>

      {/* Lista visual de addons com imagem, nome próprio e símbolo de status */}
      <div className="mt-6 border-t border-white/[0.07] pt-4">
        {addons.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-sm font-medium text-slate-300">
              Nenhum addon upstream adicionado ainda
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Use os atalhos rápidos acima ou cole a URL de qualquer addon compatível com Stremio.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {addons.map((addon) => {
              const probe = probeMap[addon.url];
              const status = probe?.status ?? 'checking';
              const displayName = addon.name || probe?.manifestName || 'Addon';
              const manifestOwnName =
                probe?.manifestName && probe.manifestName !== displayName
                  ? probe.manifestName
                  : undefined;
              const logoUrl = probe?.logo || addon.logo;
              const showLogoImage = Boolean(logoUrl) && !brokenLogos[logoUrl!];

              return (
                <li
                  key={addon.url}
                  className="flex items-center justify-between gap-3.5 py-3.5 first:pt-1 last:pb-1"
                >
                  {/* Imagem do addon (logo do manifesto ou monograma fallback) */}
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-[#0B0F17] flex items-center justify-center">
                    {showLogoImage ? (
                      <img
                        src={logoUrl}
                        alt={`Logo de ${displayName}`}
                        referrerPolicy="no-referrer"
                        onError={() =>
                          setBrokenLogos((prev) => ({
                            ...prev,
                            [logoUrl!]: true,
                          }))
                        }
                        className="h-full w-full object-contain p-1"
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="font-display text-xs font-semibold tracking-wide text-slate-300"
                      >
                        {getInitials(displayName)}
                      </span>
                    )}
                  </div>

                  {/* Nome próprio, status (Ativo / Inativo) e URL */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="truncate text-sm font-semibold text-slate-100">
                        {displayName}
                      </span>

                      {manifestOwnName && (
                        <>
                          <span aria-hidden="true" className="text-slate-600 text-xs">
                            ·
                          </span>
                          <span className="truncate text-xs text-slate-400">
                            {manifestOwnName}
                          </span>
                        </>
                      )}

                      <span aria-hidden="true" className="text-slate-600 text-xs">
                        ·
                      </span>

                      {/* Símbolo de status: Ativo / Inativo / Verificando */}
                      {status === 'active' && (
                        <span
                          className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 whitespace-nowrap"
                          title={
                            probe?.latencyMs !== undefined
                              ? `Manifesto acessível (${probe.latencyMs} ms)`
                              : 'Manifesto acessível'
                          }
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>Ativo</span>
                          {probe?.version && (
                            <span className="font-mono text-[11px] text-slate-500">
                              v{probe.version}
                            </span>
                          )}
                        </span>
                      )}

                      {status === 'inactive' && (
                        <span
                          className="inline-flex items-center gap-1 text-xs font-medium text-red-400 whitespace-nowrap"
                          title={probe?.error || 'Não foi possível carregar o manifest.json'}
                        >
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>Inativo</span>
                          {probe?.error && (
                            <span className="text-[11px] text-red-300/80">
                              ({probe.error})
                            </span>
                          )}
                        </span>
                      )}

                      {status === 'checking' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 whitespace-nowrap">
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                          <span>Verificando...</span>
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
                      {addon.url}
                    </p>
                  </div>

                  {/* Ações individuais */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onRefreshAddon(addon.url)}
                      disabled={status === 'checking'}
                      aria-label={`Verificar status de ${displayName}`}
                      title={`Verificar status de ${displayName}`}
                      className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-transparent text-slate-400 transition-colors hover:border-white/[0.1] hover:bg-white/[0.04] hover:text-slate-200 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${status === 'checking' ? 'animate-spin' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    <button
                      type="button"
                      onClick={() => onRemoveAddon(addon.url)}
                      aria-label={`Remover ${displayName}`}
                      className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-transparent text-slate-400 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 cursor-pointer"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};
