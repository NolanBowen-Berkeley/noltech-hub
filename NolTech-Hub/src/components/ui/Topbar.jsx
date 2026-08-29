// ─── Topbar (48px) ──────────────────────────────────────────────────────────
// Persistent top chrome per Layered Precision design spec. Layout:
//
//   [ Module name · Breadcrumb ] ········ [ ⌘K search ] ········ [ Sync · Avatar ]
//
// - Module name on the left, 14px / 600
// - Breadcrumb trail next to module name in 13px / 400 / muted
// - Center: search trigger that opens the command palette
// - Right: sync status indicator + theme toggle + version/menu
// - Subtle 1px bottom border, no shadow
// - Honors --sidebar-w so it aligns with the sidebar edge on md+ screens.
//
// Designed as a stateless presentational component; the parent (Shell) owns
// the palette/dark-mode state and passes the handlers in.

import { Search, Sun, Moon, Command } from 'lucide-react';
import SyncStatusIndicator from '../SyncStatusIndicator';
import { cn } from './cn';

export default function Topbar({
  moduleName,
  breadcrumb,        // optional array of { label, onClick? } segments (max 3)
  onOpenPalette,
  onToggleTheme,
  isDark,
  className,
  rightExtra,        // optional slot for module-supplied right-side controls
}) {
  return (
    <header
      className={cn(
        'app-topbar fixed top-0 right-0 z-40 flex items-center gap-4 px-4',
        'hidden md:flex',
        className,
      )}
      style={{ left: 'var(--sidebar-w, 0px)' }}
    >
      {/* Left: module name + breadcrumb */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-[14px] font-semibold text-fg tracking-tight whitespace-nowrap">
          {moduleName}
        </span>
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="flex items-center gap-1.5 text-[13px] text-fg-muted min-w-0 truncate" aria-label="Breadcrumb">
            {breadcrumb.slice(0, 3).map((seg, i) => (
              <span key={i} className="flex items-center gap-1.5 min-w-0">
                <span className="text-fg-subtle/60 select-none" aria-hidden>/</span>
                {seg.onClick ? (
                  <button
                    onClick={seg.onClick}
                    className="hover:text-fg transition-colors truncate max-w-[200px]"
                  >
                    {seg.label}
                  </button>
                ) : (
                  <span className="truncate max-w-[200px]">{seg.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
      </div>

      {/* Center: command-palette trigger (search) */}
      <button
        onClick={onOpenPalette}
        className={cn(
          'group flex items-center gap-2 max-w-[480px] w-[320px] h-8 px-3 rounded-lg',
          'bg-recessed border border-border text-[13px] text-fg-subtle',
          'hover:border-border-strong hover:text-fg-muted transition-colors',
        )}
        title="Open command palette (⌘K)"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="hidden lg:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface border border-border text-[10px] font-mono text-fg-subtle">
          <Command className="size-2.5" />K
        </kbd>
      </button>

      {/* Right: sync, theme toggle, optional extras */}
      <div className="flex items-center gap-2 ml-auto">
        {rightExtra}
        <button
          onClick={onToggleTheme}
          className="size-8 inline-flex items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-muted transition-colors"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <div className="pl-2 ml-1 border-l border-border h-5 flex items-center">
          <SyncStatusIndicator />
        </div>
      </div>
    </header>
  );
}
