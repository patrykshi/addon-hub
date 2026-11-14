import React, { useState } from 'react';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';
import type { LanguageMode, ResolutionKey, StreamHubConfig } from '../core/config.ts';

interface FilterSettingsProps {
  config: StreamHubConfig;
  onChange: (updater: (prev: StreamHubConfig) => StreamHubConfig) => void;
}

const RESOLUTION_OPTIONS: Array<{ key: ResolutionKey; label: string; is480OrUnknown?: boolean }> = [
  { key: '2160p', label: '4K (2160p)' },
  { key: '1080p', label: 'Full HD (1080p)' },
  { key: '720p', label: 'HD (720p)' },
  { key: '480p', label: '480p / Desconhecida', is480OrUnknown: true },
];

export const FilterSettings: React.FC<FilterSettingsProps> = ({ config, onChange }) => {
  const [showTmdbKey, setShowTmdbKey] = useState(false);

  const toggleResolution = (key: ResolutionKey, is480OrUnknown?: boolean) => {
    onChange((prev) => {
      const exists = prev.resolutions.includes(key);
      const nextResolutions = exists
        ? prev.resolutions.filter((r) => r !== key)
        : [...prev.resolutions, key];
      return {
        ...prev,
        resolutions: nextResolutions,
        allowUnknownRes: is480OrUnknown ? !exists : prev.allowUnknownRes,
      };
    });
  };

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = event.target.value as LanguageMode;
    onChange((prev) => ({ ...prev, languageMode: mode }));
  };

  const handleStrictToggle = () => {
    onChange((prev) => ({ ...prev, strictMetaMatch: !prev.strictMetaMatch }));
  };

  const handleTimeoutChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = Number.parseInt(event.target.value, 10);
    onChange((prev) => ({
      ...prev,
      timeoutMs: Number.isFinite(parsed) ? parsed : 6500,
    }));
  };

  const handleTimeoutBlur = () => {
    onChange((prev) => ({
      ...prev,
      timeoutMs: Math.min(30000, Math.max(1000, prev.timeoutMs || 6500)),
    }));
  };

  return (
    <section
      id="filtros"
      aria-labelledby="filters-heading"
      className="rounded-xl border border-white/[0.08] bg-[#111723] p-5 sm:p-6"
    >
      <div className="border-b border-white/[0.07] pb-4">
        <h2 id="filters-heading" className="text-lg font-semibold text-white">
          02. Filtros e Motor Anti-Mismatch
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Defina resoluções permitidas, prioridade de áudio PT-BR e validação estrita de metadados.
        </p>
      </div>

      <div className="mt-5 space-y-6">
        {/* Resoluções */}
        <fieldset>
          <legend className="text-xs font-medium text-slate-300 mb-2.5">
            Resoluções permitidas
          </legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {RESOLUTION_OPTIONS.map((option) => {
              const checked = option.is480OrUnknown
                ? config.resolutions.includes('480p') || config.allowUnknownRes
                : config.resolutions.includes(option.key);
              const inputId = `res-${option.key}`;
              return (
                <label
                  key={option.key}
                  htmlFor={inputId}
                  className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 text-sm transition-colors ${
                    checked
                      ? 'border-blue-500/40 bg-blue-500/10 text-white'
                      : 'border-white/[0.08] bg-[#0D121C] text-slate-400 hover:border-white/[0.16] hover:text-slate-200'
                  }`}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleResolution(option.key, option.is480OrUnknown)}
                    className="h-4 w-4 rounded border-slate-600 bg-[#0B0F17] text-blue-500 focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="font-medium">{option.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Seletor de Idioma */}
        <div>
          <label htmlFor="language-mode-select" className="block text-xs font-medium text-slate-300 mb-1.5">
            Preferência de idioma (PT-BR)
          </label>
          <select
            id="language-mode-select"
            value={config.languageMode}
            onChange={handleLanguageChange}
            className="w-full min-h-[44px] rounded-lg border border-white/[0.1] bg-[#0B0F17] px-3.5 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="prioritize_ptbr">
              Todos os idiomas (Priorizar PT-BR / Dual Áudio no topo)
            </option>
            <option value="only_ptbr">
              Apenas Dublado / Dual / PT-BR
            </option>
            <option value="none">
              Sem preferência de idioma
            </option>
          </select>
        </div>

        {/* Toggle Strict Match */}
        <div className="flex items-start justify-between gap-4 border-y border-white/[0.07] py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-blue-400 shrink-0" aria-hidden="true" />
              <span id="strict-match-label" className="text-sm font-medium text-white">
                Filtro Anti-Erro de Metadados (Strict Match)
              </span>
            </div>
            <p id="strict-match-desc" className="text-xs leading-relaxed text-slate-400">
              Bloqueia filmes homônimos do ano errado (tolerância de 1 ano), episódios ou temporadas trocadas e títulos incompatíveis usando Cinemeta e TMDB.
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={config.strictMetaMatch}
            aria-labelledby="strict-match-label"
            aria-describedby="strict-match-desc"
            onClick={handleStrictToggle}
            className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              config.strictMetaMatch
                ? 'border-blue-500 bg-blue-600'
                : 'border-white/20 bg-slate-800'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                config.strictMetaMatch ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Timeout & TMDB Key */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="timeout-input" className="block text-xs font-medium text-slate-300 mb-1.5">
              Timeout máximo por addon
            </label>
            <div className="relative flex items-center">
              <input
                id="timeout-input"
                type="number"
                min={1000}
                max={30000}
                step={500}
                value={config.timeoutMs}
                onChange={handleTimeoutChange}
                onBlur={handleTimeoutBlur}
                className="w-full min-h-[44px] rounded-lg border border-white/[0.1] bg-[#0B0F17] pl-3.5 pr-12 py-2 font-mono text-sm text-slate-100 tabular-nums focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <span className="pointer-events-none absolute right-3.5 font-mono text-xs text-slate-500">
                ms
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Padrão recomendado: 6500 ms (1000–30000 ms).
            </p>
          </div>

          <div>
            <label htmlFor="tmdb-key-input" className="block text-xs font-medium text-slate-300 mb-1.5">
              TMDB API Key (opcional)
            </label>
            <div className="relative flex items-center">
              <input
                id="tmdb-key-input"
                type={showTmdbKey ? 'text' : 'password'}
                value={config.tmdbApiKey || ''}
                onChange={(e) =>
                  onChange((prev) => ({ ...prev, tmdbApiKey: e.target.value }))
                }
                placeholder="Chave v3 para títulos em PT-BR"
                autoComplete="off"
                className="w-full min-h-[44px] rounded-lg border border-white/[0.1] bg-[#0B0F17] pl-3.5 pr-11 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowTmdbKey((prev) => !prev)}
                aria-label={showTmdbKey ? 'Ocultar chave TMDB' : 'Mostrar chave TMDB'}
                className="absolute right-1.5 flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
              >
                {showTmdbKey ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Reforça a validação com títulos oficiais em português.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
