import React from 'react';

interface TopBarProps {
  onGenerateClick: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ onGenerateClick }) => {
  return (
    <header className="border-b border-white/[0.08] bg-[#0B0F17]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-4 py-4 sm:px-6">
        <a
          href="/configure"
          className="flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight text-white whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-md"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="text-blue-500 shrink-0"
          >
            <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.75" />
            <path d="M10 9.25L15.5 12L10 14.75V9.25Z" fill="currentColor" />
          </svg>
          <span>StreamHub Lite</span>
        </a>

        <nav aria-label="Navegação principal" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#addons"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm"
          >
            Addons
          </a>
          <a
            href="#filtros"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm"
          >
            Filtros
          </a>
          <a
            href="#saida"
            className="hover:text-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm"
          >
            Instalação
          </a>
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onGenerateClick}
            className="rounded-lg border border-white/[0.14] bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-100 transition-colors hover:border-blue-500/50 hover:bg-blue-600/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F17] whitespace-nowrap shrink-0 cursor-pointer"
          >
            Gerar Link
          </button>
        </div>
      </div>
    </header>
  );
};
