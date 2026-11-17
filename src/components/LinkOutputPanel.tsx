import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Play, RefreshCw } from 'lucide-react';
import type { StremioStream } from '../core/matcher.ts';
import type { AddonFetchDiagnostic } from '../core/pipeline.ts';

interface LinkOutputPanelProps {
  encodedConfig: string | null;
  activeProfileId: string | null;
  activeProfileName?: string;
  hasAddons: boolean;
  validationError: string;
  onGenerate: () => void;
  isDirtySinceGenerate: boolean;
  hasUnsavedProfileChanges?: boolean;
}

interface DebugStreamResponse {
  durationMs: number;
  streams: StremioStream[];
  stats: {
    addonsQueried: number;
    addonsSucceeded: number;
    rawCount: number;
    finalCount: number;
    canonicalTitles: string[];
    canonicalYear?: number;
    addonResults?: AddonFetchDiagnostic[];
  };
  error?: string;
}

export const LinkOutputPanel: React.FC<LinkOutputPanelProps> = ({
  encodedConfig,
  activeProfileId,
  activeProfileName,
  hasAddons,
  validationError,
  onGenerate,
  isDirtySinceGenerate,
  hasUnsavedProfileChanges = false,
}) => {
  const [linkMode, setLinkMode] = useState<'profile' | 'stateless'>(
    activeProfileId ? 'profile' : 'stateless',
  );
  const [copied, setCopied] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testType, setTestType] = useState<'movie' | 'series'>('movie');
  const [testId, setTestId] = useState('tt0137523');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<DebugStreamResponse | null>(null);
  const [testError, setTestError] = useState('');

  useEffect(() => {
    if (activeProfileId) {
      setLinkMode('profile');
    } else {
      setLinkMode('stateless');
    }
  }, [activeProfileId]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const usingProfileLink = Boolean(activeProfileId) && linkMode === 'profile';

  const manifestHttpUrl = usingProfileLink && activeProfileId
    ? `${origin}/p/${activeProfileId}/manifest.json`
    : encodedConfig
      ? `${origin}/${encodedConfig}/manifest.json`
      : '';

  const manifestStremioUrl = manifestHttpUrl
    ? manifestHttpUrl.replace(/^https?:\/\//i, 'stremio://')
    : '';

  const editConfigureUrl = usingProfileLink && activeProfileId
    ? `/p/${activeProfileId}/configure`
    : encodedConfig
      ? `/${encodedConfig}/configure`
      : '';

  const hasReadyOutput = Boolean(manifestHttpUrl);

  const handleCopy = async () => {
    if (!manifestHttpUrl) return;
    try {
      await navigator.clipboard.writeText(manifestHttpUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = manifestHttpUrl;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  };

  const handleRunTest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!hasReadyOutput) return;
    const trimmed = testId.trim();
    if (!trimmed) {
      setTestError('Informe um ID válido (ex: tt0137523 ou tt0903747:1:5).');
      return;
    }

    setTestLoading(true);
    setTestError('');
    setTestResult(null);

    try {
      const debugPath = usingProfileLink && activeProfileId
        ? `/p/${activeProfileId}/debug-stream/${encodeURIComponent(testType)}/${encodeURIComponent(trimmed)}.json`
        : `/${encodedConfig}/debug-stream/${encodeURIComponent(testType)}/${encodeURIComponent(trimmed)}.json`;

      const response = await fetch(debugPath);
      const data = (await response.json()) as DebugStreamResponse;
      if (!response.ok || data.error) {
        setTestError(data.error || 'Falha ao consultar o pipeline.');
      } else {
        setTestResult(data);
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Erro de rede ao testar pipeline.');
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <aside
      id="saida"
      aria-labelledby="output-heading"
      className="rounded-xl border border-white/[0.08] bg-[#111723] p-5 sm:p-6 lg:sticky lg:top-6"
    >
      <div className="border-b border-white/[0.07] pb-4">
        <h2 id="output-heading" className="text-lg font-semibold text-white">
          03. Gerador de Links
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Use o link permanente do seu perfil salvo ou um link Stateless em Base64URL.
        </p>
      </div>

      <div className="mt-5 space-y-4">
        {activeProfileId && (
          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1 border border-white/[0.06]">
            <button
              type="button"
              onClick={() => setLinkMode('profile')}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                linkMode === 'profile'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Link Permanente (Perfil)
            </button>
            <button
              type="button"
              onClick={() => {
                setLinkMode('stateless');
                if (!encodedConfig && hasAddons) {
                  onGenerate();
                }
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                linkMode === 'stateless'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Stateless (Base64URL)
            </button>
          </div>
        )}

        {(!usingProfileLink || !activeProfileId) && (
          <button
            type="button"
            onClick={onGenerate}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#111723] cursor-pointer"
          >
            <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {encodedConfig && isDirtySinceGenerate
                ? 'Atualizar Link Stateless'
                : 'Gerar Link Stateless'}
            </span>
          </button>
        )}

        {validationError && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs font-medium text-red-300">
            {validationError}
          </p>
        )}

        {usingProfileLink && hasUnsavedProfileChanges && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200">
            Você editou este perfil. Clique em &ldquo;Atualizar Perfil&rdquo; no topo para sincronizar o link permanente com o Nuvio/Stremio.
          </p>
        )}

        {!usingProfileLink && encodedConfig && isDirtySinceGenerate && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-200">
            Você alterou opções após gerar o link. Clique em &ldquo;Atualizar Link Stateless&rdquo; para refletir as mudanças na URL.
          </p>
        )}

        {!hasReadyOutput ? (
          <div className="border-t border-white/[0.07] pt-5 pb-2 text-center">
            <p className="text-sm font-medium text-slate-300">
              {hasAddons
                ? 'Pronto para gerar sua URL'
                : 'Adicione pelo menos 1 addon para começar'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Salve um perfil na nuvem para obter uma URL permanente ou gere um link Stateless.
            </p>
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            <div>
              <label htmlFor="generated-manifest-url" className="block text-xs font-medium text-slate-300 mb-1.5">
                {usingProfileLink
                  ? `URL Permanente${activeProfileName ? ` · ${activeProfileName}` : ''}`
                  : 'URL do Manifesto (HTTP / Stateless)'}
              </label>
              <input
                id="generated-manifest-url"
                type="text"
                readOnly
                value={manifestHttpUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full min-h-[44px] rounded-lg border border-white/[0.1] bg-[#0B0F17] px-3.5 py-2 font-mono text-xs text-blue-300 focus:border-blue-500 focus:outline-none"
              />
              {usingProfileLink && (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  Instale esta URL uma única vez no Nuvio/Stremio. Futuras edições neste perfil atualizam seus addons automaticamente.
                </p>
              )}
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleCopy}
                className={`flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  copied
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                    : 'border-white/[0.12] bg-[#161E2E] text-slate-100 hover:border-white/25 hover:bg-[#1C263B]'
                }`}
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Copiado!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Copiar URL (Para Nuvio / Stremio Web)</span>
                  </>
                )}
              </button>

              <a
                href={manifestStremioUrl}
                className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-sm font-medium text-blue-200 transition-colors hover:bg-blue-500/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Instalar no Stremio</span>
              </a>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] pt-3 text-xs text-slate-400">
              <a
                href={manifestHttpUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-white underline-offset-4 hover:underline"
              >
                Ver manifest.json
              </a>
              <span aria-hidden="true">·</span>
              <a
                href={editConfigureUrl}
                className="hover:text-white underline-offset-4 hover:underline"
              >
                Link direto desta edição
              </a>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => setTestOpen((prev) => !prev)}
                className="font-medium text-blue-400 hover:text-blue-300 cursor-pointer"
              >
                {testOpen ? 'Ocultar teste' : 'Testar pipeline'}
              </button>
            </div>

            {testOpen && (
              <div className="rounded-lg border border-white/[0.08] bg-[#0D121C] p-3.5 space-y-3">
                <p className="text-xs font-medium text-slate-300">
                  Testar agregação ao vivo
                </p>
                <form onSubmit={handleRunTest} className="space-y-2.5">
                  <div className="flex gap-2">
                    <select
                      aria-label="Tipo de mídia"
                      value={testType}
                      onChange={(e) => {
                        const next = e.target.value as 'movie' | 'series';
                        setTestType(next);
                        setTestId(next === 'movie' ? 'tt0137523' : 'tt0903747:1:5');
                      }}
                      className="min-h-[40px] rounded-md border border-white/[0.1] bg-[#0B0F17] px-2.5 text-xs text-slate-100"
                    >
                      <option value="movie">Filme</option>
                      <option value="series">Série</option>
                    </select>
                    <input
                      type="text"
                      aria-label="ID IMDb para teste"
                      value={testId}
                      onChange={(e) => setTestId(e.target.value)}
                      placeholder="tt0137523"
                      className="min-w-0 flex-1 min-h-[40px] rounded-md border border-white/[0.1] bg-[#0B0F17] px-3 font-mono text-xs text-slate-100"
                    />
                    <button
                      type="submit"
                      disabled={testLoading}
                      className="flex min-h-[40px] items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60 cursor-pointer"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{testLoading ? 'Buscando...' : 'Executar'}</span>
                    </button>
                  </div>
                </form>

                {testError && (
                  <p className="text-xs text-red-400">{testError}</p>
                )}

                {testResult && (
                  <div className="space-y-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2 text-slate-400 tabular-nums">
                      <span>{testResult.stats.addonsSucceeded}/{testResult.stats.addonsQueried} addons</span>
                      <span aria-hidden="true">·</span>
                      <span>{testResult.stats.rawCount} brutas → {testResult.stats.finalCount} válidas</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{testResult.durationMs} ms</span>
                    </div>
                    {testResult.stats.canonicalTitles.length > 0 && (
                      <p className="text-slate-400 truncate">
                        Canônico: <span className="text-slate-200">{testResult.stats.canonicalTitles[0]}</span>
                        {testResult.stats.canonicalYear ? ` (${testResult.stats.canonicalYear})` : ''}
                      </p>
                    )}
                    {testResult.stats.addonResults && testResult.stats.addonResults.length > 0 && (
                      <ul className="max-h-32 overflow-y-auto divide-y divide-white/[0.05] rounded border border-white/[0.06] bg-[#0B0F17] px-2.5">
                        {testResult.stats.addonResults.map((item) => (
                          <li key={item.url} className="flex items-center justify-between gap-2 py-1.5 text-[11px]">
                            <span className="truncate text-slate-300">{item.name}</span>
                            <span className={`font-mono shrink-0 tabular-nums ${item.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                              {item.ok ? `${item.rawCount} · ${item.durationMs}ms` : item.error}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {testResult.streams.length === 0 ? (
                      <p className="text-slate-500">Nenhuma stream retornada pelos addons para este ID.</p>
                    ) : (
                      <ul className="max-h-44 overflow-y-auto divide-y divide-white/[0.06] rounded border border-white/[0.06] bg-[#0B0F17]">
                        {testResult.streams.slice(0, 8).map((stream, idx) => (
                          <li key={idx} className="px-2.5 py-2">
                            <p className="font-medium text-slate-100">{stream.name}</p>
                            {stream.title && (
                              <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                                {stream.title.split('\n')[0]}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
