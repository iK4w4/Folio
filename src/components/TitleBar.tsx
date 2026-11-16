import React, { useState, useEffect } from 'react';
import { Minus, Square, Copy, X, Plus, Settings, HelpCircle, Info } from 'lucide-react';
import { isTauri } from '../lib/storage';

interface TitleBarProps {
  onNewNote: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onOpenShortcuts: () => void;
  // App flushes the pending editor save + settings persist before closing.
  onRequestClose?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  onNewNote,
  onOpenSettings,
  onOpenAbout,
  onOpenShortcuts,
  onRequestClose,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const setupTauri = async () => {
      if (isTauri()) {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const appWindow = getCurrentWindow();
          const maximized = await appWindow.isMaximized();
          if (!disposed) setIsMaximized(maximized);
          const off = await appWindow.onResized(async () => {
            const next = await appWindow.isMaximized();
            if (!disposed) setIsMaximized(next);
          });
          if (!disposed) unlisten = off;
          else off();
        } catch (e) {
          console.warn('Window state listener error:', e);
        }
      }
    };

    void setupTauri();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const handleMinimize = async () => {
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().minimize();
      } catch (err) {
        console.warn('Tauri minimize error:', err);
      }
    }
  };

  const handleToggleMaximize = async () => {
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().toggleMaximize();
        setIsMaximized(await getCurrentWindow().isMaximized());
      } catch (err) {
        console.warn('Tauri maximize error:', err);
      }
    } else {
      setIsMaximized((v) => !v);
    }
  };

  // Double-click anywhere on the header toggles maximize — buttons are
  // pointer-events-auto so a double-click on a button never reaches here.
  const handleHeaderDoubleClick = (e: React.MouseEvent) => {
    // Tauri's drag region already toggles maximize on double-click, so the
    // React handler only runs in the browser preview. In Tauri the native
    // behavior wins, otherwise it would toggle twice.
    if (isTauri()) return;
    const target = e.target as HTMLElement;
    // Ignore double-clicks that start on an interactive element (buttons,
    // links, inputs) — those are clicks, not drag-region toggles.
    if (target.closest('button, input, a, select, textarea')) return;
    void handleToggleMaximize();
  };

  const handleClose = async () => {
    // App awaits the pending save + settings persist first.
    if (onRequestClose) {
      try {
        await onRequestClose();
        return;
      } catch (err) {
        // The flush already ran inside the request; if the close itself
        // failed, try closing directly instead of leaving the window stuck.
        console.warn('Close request failed, trying a direct close:', err);
      }
    }
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().close();
      } catch (err) {
        console.warn('Tauri close error:', err);
      }
    }
  };

  const winBtn =
    'w-8 h-8 flex items-center justify-center theme-muted hover:text-[var(--text)] hover:bg-[var(--raised)] transition-all duration-150 rounded-lg hover:scale-110 active:scale-95';

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={handleHeaderDoubleClick}
      className="h-10 w-full flex items-center justify-between px-3 select-none border-b theme-border glass z-40 shrink-0 text-xs"
    >
      {/* Brand & Identity */}
      <div className="flex items-center gap-2.5 pointer-events-auto" data-tauri-drag-region>
        <img src="/folio-icon.png" alt="Folio" className="w-5 h-5 rounded-md shadow-sm transition-transform duration-150 hover:scale-110" />
        <span className="font-bold tracking-tight bg-gradient-to-r from-[var(--text)] to-[var(--muted)] bg-clip-text text-transparent">
          Folio
        </span>
      </div>

      {/* Middle Drag Area */}
      <div className="flex-1 h-full" data-tauri-drag-region />

      {/* Top Utilities & Window Controls */}
      <div className="flex items-center gap-1.5 pointer-events-auto">
        <button
          onClick={onNewNote}
          title="New Note (Ctrl+N)"
          className="flex items-center gap-1.5 px-3 py-1 rounded-xl btn-accent font-semibold text-xs shadow-md transition-all duration-150 hover:scale-105 active:scale-95 mr-1"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New</span>
        </button>

        <button
          onClick={onOpenShortcuts}
          title="Keyboard Shortcuts"
          className="p-1.5 rounded-lg btn-ghost theme-muted hover:text-[var(--text)] transition-all duration-150 hover:scale-105 active:scale-95"
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onOpenSettings}
          title="Settings (Theme, Zoom, Glass, Backup)"
          className="p-1.5 rounded-lg btn-ghost theme-muted hover:text-[var(--text)] transition-all duration-150 hover:scale-105 active:scale-95"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onOpenAbout}
          title="About Folio"
          className="p-1.5 rounded-lg btn-ghost theme-muted hover:text-[var(--text)] transition-all duration-150 hover:scale-105 active:scale-95 mr-2"
        >
          <Info className="w-3.5 h-3.5" />
        </button>

        {/* Windows Caption Controls */}
        <div className="flex items-center -mr-1">
          <button onClick={handleMinimize} title="Minimize" className={winBtn}>
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleToggleMaximize}
            title={isMaximized ? 'Restore' : 'Maximize'}
            className={winBtn}
          >
            {isMaximized ? <Copy className="w-3 h-3 rotate-180" /> : <Square className="w-3 h-3" />}
          </button>
          <button
            onClick={handleClose}
            title="Close"
            className="w-8 h-8 flex items-center justify-center theme-muted hover:text-white transition-all duration-150 rounded-lg hover:scale-110 active:scale-95 hover:bg-[var(--danger)] hover:shadow-[0_0_14px_var(--danger)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
