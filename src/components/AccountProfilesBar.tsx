import React, { useState } from 'react';
import type { User } from 'firebase/auth';
import { Check, Cloud, LogIn, LogOut, Plus, Save, Star, Trash2 } from 'lucide-react';
import type { SavedProfile } from '../services/profileService.ts';

interface AccountProfilesBarProps {
  user: User | null;
  authLoading: boolean;
  authError: string;
  profiles: SavedProfile[];
  activeProfileId: string | null;
  defaultProfileId?: string;
  profileNameInput: string;
  savingProfile: boolean;
  saveFeedback: string;
  saveError: string;
  hasAddons: boolean;
  onProfileNameChange: (value: string) => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onSaveProfile: (asNew: boolean) => void;
  onSelectProfile: (profile: SavedProfile) => void;
  onSetDefaultProfile: (profileId: string) => void;
  onDeleteProfile: (profile: SavedProfile) => void;
  onStartNewDraft: () => void;
}

function getUserInitials(user: User): string {
  const source = user.displayName || user.email || 'US';
  const parts = source.trim().split(/[\s@]+/).filter(Boolean);
  if (parts.length === 0) return 'US';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export const AccountProfilesBar: React.FC<AccountProfilesBarProps> = ({
  user,
  authLoading,
  authError,
  profiles,
  activeProfileId,
  defaultProfileId,
  profileNameInput,
  savingProfile,
  saveFeedback,
  saveError,
  hasAddons,
  onProfileNameChange,
  onSignIn,
  onSignOut,
  onSaveProfile,
  onSelectProfile,
  onSetDefaultProfile,
  onDeleteProfile,
  onStartNewDraft,
}) => {
  const [avatarFailed, setAvatarFailed] = useState(false);

  return (
    <section
      id="perfis"
      aria-labelledby="profiles-heading"
      className="rounded-xl border border-white/[0.08] bg-[#111723] p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-blue-400 shrink-0" aria-hidden="true" />
            <h2 id="profiles-heading" className="text-lg font-semibold text-white">
              Conta e Perfis Salvos na Nuvem
            </h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Salve suas configurações na sua conta para não perdê-las a cada atualização e use um link permanente no Nuvio e Stremio.
          </p>
        </div>

        <div className="shrink-0">
          {authLoading ? (
            <span className="text-xs text-slate-400">Verificando sessão...</span>
          ) : !user ? (
            <button
              type="button"
              onClick={onSignIn}
              className="flex min-h-[42px] items-center gap-2 rounded-lg border border-blue-500/45 bg-blue-600/15 px-4 py-2 text-sm font-semibold text-blue-200 transition-colors hover:bg-blue-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 whitespace-nowrap cursor-pointer"
            >
              <LogIn className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Entrar com Google</span>
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-white/[0.1] bg-[#0B0F17] flex items-center justify-center">
                  {user.photoURL && !avatarFailed ? (
                    <img
                      src={user.photoURL}
                      alt={user.displayName || 'Avatar do usuário'}
                      referrerPolicy="no-referrer"
                      onError={() => setAvatarFailed(true)}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="font-display text-xs font-semibold text-slate-200">
                      {getUserInitials(user)}
                    </span>
                  )}
                </div>
                <div className="hidden sm:block text-right">
                  <p className="text-xs font-semibold text-slate-100 truncate max-w-[160px]">
                    {user.displayName || 'Minha Conta'}
                  </p>
                  <p className="text-[11px] text-slate-400 truncate max-w-[160px]">
                    {user.email}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={onSignOut}
                className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/[0.1] bg-[#0B0F17] px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 whitespace-nowrap cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Sair</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {authError && (
        <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs font-medium text-red-300">
          {authError}
        </p>
      )}

      {!user ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>
            Rascunhos locais continuam salvos automaticamente neste navegador. Faça login para sincronizar entre dispositivos e gerar URL fixa <span className="font-mono text-slate-300">/p/.../manifest.json</span>.
          </span>
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {/* Formulário para salvar ou atualizar perfil atual */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSaveProfile(!activeProfileId);
            }}
            className="grid grid-cols-1 gap-3 sm:grid-cols-12"
          >
            <div className="sm:col-span-6">
              <label htmlFor="cloud-profile-name" className="block text-xs font-medium text-slate-300 mb-1.5">
                Nome do perfil salvo
              </label>
              <input
                id="cloud-profile-name"
                type="text"
                value={profileNameInput}
                onChange={(e) => onProfileNameChange(e.target.value)}
                placeholder="Ex: Principal Nuvio + Stremio"
                maxLength={60}
                className="w-full min-h-[42px] rounded-lg border border-white/[0.1] bg-[#0B0F17] px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div className="sm:col-span-6 flex flex-wrap items-end gap-2">
              <button
                type="submit"
                disabled={savingProfile || !hasAddons}
                className="flex min-h-[42px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 whitespace-nowrap cursor-pointer"
              >
                <Save className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {savingProfile
                    ? 'Salvando...'
                    : activeProfileId
                      ? 'Atualizar Perfil'
                      : 'Salvar Perfil'}
                </span>
              </button>

              {activeProfileId && (
                <>
                  <button
                    type="button"
                    disabled={savingProfile || !hasAddons}
                    onClick={() => onSaveProfile(true)}
                    className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg border border-white/[0.12] bg-[#161E2E] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 hover:text-white disabled:opacity-50 whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Salvar como Novo</span>
                  </button>
                  <button
                    type="button"
                    onClick={onStartNewDraft}
                    className="min-h-[42px] rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:border-white/20 hover:text-slate-200 whitespace-nowrap cursor-pointer"
                  >
                    Desvincular
                  </button>
                </>
              )}
            </div>
          </form>

          {saveError && (
            <p role="alert" className="text-xs font-medium text-red-400">
              {saveError}
            </p>
          )}
          {saveFeedback && (
            <p role="status" className="text-xs font-medium text-emerald-400">
              {saveFeedback}
            </p>
          )}

          {/* Lista de perfis salvos */}
          <div className="border-t border-white/[0.07] pt-4">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <p className="text-xs font-medium text-slate-300">
                Meus Perfis na Nuvem
              </p>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {profiles.length} {profiles.length === 1 ? 'salvo' : 'salvos'}
              </span>
            </div>

            {profiles.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">
                Nenhum perfil salvo ainda. Adicione seus addons abaixo e clique em &ldquo;Salvar Perfil&rdquo; para criar seu link permanente.
              </p>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {profiles.map((profile) => {
                  const isActive = profile.id === activeProfileId;
                  const isDefault = profile.id === defaultProfileId;
                  return (
                    <li
                      key={profile.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-1 last:pb-1"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate text-sm font-medium text-slate-100">
                            {profile.name}
                          </span>
                          <span aria-hidden="true" className="text-slate-600 text-xs">
                            ·
                          </span>
                          <span className="font-mono text-xs text-slate-400 tabular-nums">
                            {profile.config.addons.length} {profile.config.addons.length === 1 ? 'addon' : 'addons'}
                          </span>
                          {isDefault && (
                            <>
                              <span aria-hidden="true" className="text-slate-600 text-xs">
                                ·
                              </span>
                              <span className="text-xs font-medium text-blue-400">
                                Padrão ao entrar
                              </span>
                            </>
                          )}
                          {isActive && (
                            <>
                              <span aria-hidden="true" className="text-slate-600 text-xs">
                                ·
                              </span>
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                <span>Em edição</span>
                              </span>
                            </>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                          /p/{profile.id}/manifest.json
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => onSelectProfile(profile)}
                          className={`min-h-[38px] rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                            isActive
                              ? 'border-blue-500/40 bg-blue-500/15 text-blue-200'
                              : 'border-white/[0.1] bg-[#0B0F17] text-slate-200 hover:border-blue-500/40 hover:text-white'
                          }`}
                        >
                          {isActive ? 'Carregado' : 'Carregar'}
                        </button>

                        <button
                          type="button"
                          onClick={() => onSetDefaultProfile(profile.id)}
                          disabled={isDefault}
                          aria-label={`Definir ${profile.name} como padrão`}
                          title={isDefault ? 'Perfil padrão atual' : 'Definir como perfil padrão'}
                          className={`flex min-h-[38px] min-w-[38px] items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                            isDefault
                              ? 'border-blue-500/30 bg-blue-500/10 text-blue-400 cursor-default'
                              : 'border-transparent text-slate-400 hover:border-white/[0.1] hover:bg-white/[0.04] hover:text-slate-200'
                          }`}
                        >
                          <Star className="h-4 w-4" aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteProfile(profile)}
                          aria-label={`Excluir perfil ${profile.name}`}
                          title={`Excluir perfil ${profile.name}`}
                          className="flex min-h-[38px] min-w-[38px] items-center justify-center rounded-lg border border-transparent text-slate-400 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400 cursor-pointer"
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
        </div>
      )}
    </section>
  );
};
