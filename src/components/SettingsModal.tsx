import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Moon,
  Sun,
  ZoomIn,
  RefreshCw,
  FileText,
  Download,
  CheckCircle2,
  Palette,
  Sparkles,
  Info,
  FolderOpen,
  Type,
} from 'lucide-react';
import { AppSettings, PaletteId } from '../types/note';
import { PALETTES, glassFilterForIntensity } from '../lib/themes';
import {
  restoreFromBackup,
  exportAllNotes,
  exportBackupCopy,
  getDataDirPath,
  openDataDir,
  isTauri,
} from '../lib/storage';

interface SettingsModalProps {
  isOpen: boolean;
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  /** Apply a change to the live UI immediately; persistence is debounced. */
  onPreviewSettings?: (newSettings: AppSettings) => void;
  onClose: () => void;
  onRefreshNotes: () => void;
  onExportAll?: () => void;
  // App holds this ref: the window close handler flushes a pending slider
  // persist before the WebView tears down.
  flushRef?: { current: (() => void) | null };
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onUpdateSettings,
  onPreviewSettings,
  onClose,
  onRefreshNotes,
  onExportAll,
  flushRef,
}) => {
  const [restoreFeedback, setRestoreFeedback] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Element that opened the dialog — focus returns to it on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  // Only capture the trigger on the closed -> open transition.
  const wasOpenRef = useRef(false);
  // Latest close callback: the key handler below subscribes once per open
  // instead of re-subscribing on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Sliders write through on every tick. The live UI updates on every tick
  // and only the disk write is debounced, so the thumb never freezes.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        // Persist the final slider position instead of dropping it.
        void onUpdateSettings(latestSettingsRef.current);
      }
    };
  }, [onUpdateSettings]);

  // Fresh feedback each time the modal opens (it stays mounted).
  useEffect(() => {
    if (isOpen) {
      setRestoreFeedback(null);
      setExportFeedback(null);
      setBackupNote(null);
    }
  }, [isOpen]);

  const schedulePersist = (next: AppSettings) => {
    latestSettingsRef.current = next;
    onPreviewSettings?.(next);
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      void onUpdateSettings(latestSettingsRef.current);
    }, 250);
  };

  // Flush a pending slider persist now (modal close, window close). A
  // glassiness/zoom/font-size tweak followed by an immediate exit would
  // otherwise lose the final tick to the 250ms debounce.
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
      void onUpdateSettings(latestSettingsRef.current);
    }
  }, [onUpdateSettings]);

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flushPersist;
    return () => {
      flushRef.current = null;
    };
  }, [flushRef, flushPersist]);

  // One close path — every exit flushes the pending slider persist first.
  const close = useCallback(() => {
    flushPersist();
    onCloseRef.current();
  }, [flushPersist]);

  // Move focus into the dialog on open, so Tab starts inside it instead of
  // walking the app behind the modal and activating background controls.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen) {
      if (!wasOpen) {
        triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  // Focus restore: when the dialog closes, focus goes back to the element
  // that opened it instead of staying on the background.
  useEffect(() => {
    if (!isOpen && triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [isOpen]);

  // Escape closes the modal (the global shortcut handler deliberately
  // ignores keys while a modal is open, so each modal owns this).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        return;
      }
      // Trap Tab inside the dialog while open. The containment check keeps
      // this inert while the confirm dialog stacked above this one owns Tab:
      // focus then sits inside that dialog, not inside this one.
      if (e.key === 'Tab' && dialogRef.current) {
        if (!dialogRef.current.contains(document.activeElement)) return;
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  if (!isOpen) return null;

  const glassiness = settings.glassiness;
  const glassFilter = glassFilterForIntensity(glassiness);
  const glassDesc =
    glassiness <= 20 ? 'Solid' : glassiness <= 55 ? 'Soft frost' : glassiness <= 85 ? 'Frosted' : 'Full frost';

  const handleThemeChange = (theme: 'dark' | 'light') => {
    onUpdateSettings({ ...settings, theme });
  };

  const handlePaletteChange = (palette: PaletteId) => {
    onUpdateSettings({ ...settings, palette });
  };

  const handleZoomChange = (zoom: number) => {
    schedulePersist({ ...latestSettingsRef.current, zoom });
  };

  const handleGlassinessChange = (value: number) => {
    schedulePersist({ ...latestSettingsRef.current, glassiness: value });
  };

  const handleFontSizeChange = (value: number) => {
    schedulePersist({ ...latestSettingsRef.current, editorFontSize: value });
  };

  const handleRestoreBackup = async () => {
    setIsRestoring(true);
    setRestoreFeedback(null);
    try {
      const result = await restoreFromBackup();
      setRestoreFeedback(result.message);
      onRefreshNotes();
    } catch (err: unknown) {
      setRestoreFeedback((err as Error).message || 'Failed to restore backup');
    } finally {
      setIsRestoring(false);
    }
  };

  const handleDownloadBackupTxt = async () => {
    setBackupNote(null);
    try {
      const result = await exportBackupCopy();
      if (isTauri()) {
        // Desktop: the backend wrote a copy into Exports/ and returned its path.
        setExportFeedback(`Saved a copy of All Notes.txt to: ${result}`);
        return;
      }
      const blob = new Blob([result], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'All Notes.txt';
      a.click();
      // The object URL is revoked after a delay: revoking it at once can
      // cancel the download before WebView2 starts it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setBackupNote((err as Error).message || 'Backup export is unavailable here.');
    }
  };

  const handleOpenDataFolder = async () => {
    setBackupNote(null);
    try {
      if (!isTauri()) {
        setBackupNote(await getDataDirPath());
        return;
      }
      await openDataDir();
    } catch (err) {
      setBackupNote((err as Error).message || 'Could not open the data folder.');
    }
  };

  const handleExportAll = async () => {
    setExportFeedback(null);
    if (onExportAll) {
      onExportAll();
      return;
    }
    try {
      const msg = await exportAllNotes();
      setExportFeedback(msg);
    } catch (err) {
      setExportFeedback((err as Error).message || 'Export failed.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        className="glass-strong w-full max-w-lg rounded-2xl p-6 select-none animate-modal-in flex flex-col max-h-[90vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b theme-border">
          <div>
            <h2 className="text-base font-bold theme-text">Preferences</h2>
            <p className="text-xs theme-muted mt-0.5">Color theme, mode, zoom, glass, editor, and backup</p>
          </div>
          <button
            onClick={close}
            className="p-1.5 rounded-lg btn-ghost theme-muted hover:text-[var(--text)] transition-all hover:scale-105 active:scale-95"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable body. The 10px gutter keeps every row clear of the
            scrollbar, whose thumb would otherwise clip their right corners. */}
        <div className="flex-1 overflow-y-auto py-5 space-y-6 pr-2.5">
          {/* Color Theme — the Pico palettes */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4 theme-accent" />
              <label className="text-xs font-semibold uppercase tracking-wider">Color Theme</label>
            </div>
            <p className="text-[11px] theme-muted leading-relaxed">
              Pico's sixteen palettes. Pick one — it colors the whole app, and it is saved with your other settings.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {PALETTES.map((p) => {
                const selected = settings.palette === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => handlePaletteChange(p.id)}
                    className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-all duration-150 hover:scale-[1.02] active:scale-95 ${
                      selected
                        ? 'border-[var(--accent)] bg-[var(--raised)] font-semibold shadow-[0_0_0_1px_var(--accent)]'
                        : 'control-card hover:bg-[var(--raised)]'
                    }`}
                    title={p.name}
                  >
                    <span className="palette-bar" aria-hidden="true">
                      {p.slots.map((hex, i) => (
                        <span key={i} className="palette-bar-seg" style={{ backgroundColor: hex }} />
                      ))}
                    </span>
                    <span className="text-xs truncate">{p.name}</span>
                    {selected && <span className="ml-auto text-[10px] theme-accent font-bold">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Theme Option (Dark + Light only, no Auto) */}
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wider">Theme Mode</label>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => handleThemeChange('dark')}
                className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-medium transition-all duration-150 hover:scale-[1.02] active:scale-95 ${
                  settings.theme === 'dark'
                    ? 'border-[var(--accent)] bg-[var(--raised)] font-semibold shadow-[0_0_0_1px_var(--accent)]'
                    : 'control-card theme-muted hover:text-[var(--text)]'
                }`}
              >
                <Moon className="w-4 h-4" />
                <span>Dark (Default)</span>
              </button>

              <button
                onClick={() => handleThemeChange('light')}
                className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-medium transition-all duration-150 hover:scale-[1.02] active:scale-95 ${
                  settings.theme === 'light'
                    ? 'border-[var(--accent)] bg-[var(--raised)] font-semibold shadow-[0_0_0_1px_var(--accent)]'
                    : 'control-card theme-muted hover:text-[var(--text)]'
                }`}
              >
                <Sun className="w-4 h-4" />
                <span>Light</span>
              </button>
            </div>
          </div>

          {/* Zoom Slider (90% to 150%) */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ZoomIn className="w-4 h-4 theme-accent" />
                <label className="text-xs font-semibold">Interface Zoom</label>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono theme-accent font-bold tabular-nums">{settings.zoom}%</span>
                {settings.zoom !== 100 && (
                  <button
                    onClick={() => handleZoomChange(100)}
                    className="text-[10px] theme-muted hover:text-[var(--accent)] underline transition-colors"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
            <input
              type="range"
              min="90"
              max="150"
              step="5"
              value={settings.zoom}
              onChange={(e) => handleZoomChange(Number(e.target.value))}
              className="w-full cursor-pointer h-2 rounded-lg"
              style={{ accentColor: 'var(--accent)' }}
            />
            <div className="flex justify-between text-[10px] theme-faint font-mono">
              <span>90% (Compact)</span>
              <span>100% (Default)</span>
              <span>150% (Comfortable)</span>
            </div>
          </div>

          {/* Glassiness Slider (0–100) — live preview via applyTheme() */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 theme-accent" />
                <label className="text-xs font-semibold">Glassiness</label>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono theme-accent font-bold tabular-nums">{glassiness}%</span>
                <span className="glass-chip font-mono tabular-nums">
                  {glassDesc} · {Math.round(glassFilter.blurPx)}px blur
                </span>
                {glassiness !== 70 && (
                  <button
                    onClick={() => handleGlassinessChange(70)}
                    className="text-[10px] theme-muted hover:text-[var(--accent)] underline transition-colors"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={glassiness}
              onChange={(e) => handleGlassinessChange(Number(e.target.value))}
              className="w-full cursor-pointer h-2 rounded-lg"
              style={{ accentColor: 'var(--accent)' }}
              aria-label="Glassiness"
            />
            <div className="flex justify-between text-[10px] theme-faint font-mono">
              <span>0 (Solid)</span>
              <span>70 (Frosted)</span>
              <span>100 (Full frost)</span>
            </div>
            <p className="text-[11px] theme-muted leading-relaxed">
              How frosted the glass panels look. The preview updates live across the whole app.
            </p>
          </div>

          {/* Bold interface text: bolds the app's own labels,
              buttons, lists and menus — never the note text. */}
          <label className="flex items-center justify-between p-3 setting-row cursor-pointer hover:border-[var(--accent)] transition-all duration-150 active:scale-[0.99]">
            <span className="text-xs font-semibold">Bold interface text</span>
            <input
              type="checkbox"
              checked={settings.uiBold}
              onChange={(e) => onUpdateSettings({ ...settings, uiBold: e.target.checked })}
            />
          </label>

          {/* Editor preferences. The rows use the soft .setting-row surface:
              a solid step up from the container, so no corner reads as a
              sharp cut against the glass modal. */}
          <div className="space-y-3 pt-2 border-t theme-border">
            <label className="text-xs font-semibold uppercase tracking-wider">Editor Options</label>
            <div className="space-y-2">
              <div className="p-3 setting-row space-y-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs">
                    <Type className="w-4 h-4 theme-accent" />
                    Editor text size
                  </span>
                  <span className="text-xs font-mono theme-accent font-bold tabular-nums">
                    {settings.editorFontSize}px
                  </span>
                </div>
                <input
                  type="range"
                  min="12"
                  max="26"
                  step="1"
                  value={settings.editorFontSize}
                  onChange={(e) => handleFontSizeChange(Number(e.target.value))}
                  className="w-full cursor-pointer h-2 rounded-lg"
                  style={{ accentColor: 'var(--accent)' }}
                  aria-label="Editor text size"
                />
              </div>

              {/* Editor font: System / Serif / Monospace, each with a live
                  "Ag" preview in that font. */}
              <div className="p-3 setting-row space-y-2">
                <span className="flex items-center gap-2 text-xs">
                  <Type className="w-4 h-4 theme-accent" />
                  Editor font
                </span>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { id: 'system', label: 'System', preview: "'Segoe UI', system-ui, sans-serif" },
                      { id: 'serif', label: 'Serif', preview: "Georgia, 'Times New Roman', serif" },
                      { id: 'mono', label: 'Monospace', preview: "'Cascadia Mono', Consolas, monospace" },
                    ] as const
                  ).map((opt) => {
                    const selected = settings.editorFontFamily === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => onUpdateSettings({ ...settings, editorFontFamily: opt.id })}
                        className={`flex flex-col items-center gap-0.5 px-2 py-2 rounded-xl border text-xs transition-all duration-150 hover:scale-[1.02] active:scale-95 ${
                          selected
                            ? 'border-[var(--accent)] bg-[var(--raised)] font-semibold shadow-[0_0_0_1px_var(--accent)]'
                            : 'control-card theme-muted hover:text-[var(--text)]'
                        }`}
                        title={opt.label}
                      >
                        <span className="text-base leading-none theme-text" style={{ fontFamily: opt.preview }}>
                          Ag
                        </span>
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="flex items-center justify-between p-3 setting-row cursor-pointer hover:border-[var(--accent)] transition-all duration-150 active:scale-[0.99]">
                <span className="text-xs">Browser spellcheck</span>
                <input
                  type="checkbox"
                  checked={settings.spellCheck}
                  onChange={(e) => onUpdateSettings({ ...settings, spellCheck: e.target.checked })}
                />
              </label>

              <label className="flex items-center justify-between p-3 setting-row cursor-pointer hover:border-[var(--accent)] transition-all duration-150 active:scale-[0.99]">
                <span className="text-xs">Line numbers in editor</span>
                <input
                  type="checkbox"
                  checked={settings.lineNumbers}
                  onChange={(e) => onUpdateSettings({ ...settings, lineNumbers: e.target.checked })}
                />
              </label>
            </div>
          </div>

          {/* Backup & Restore (All Notes.txt) */}
          <div className="space-y-3 pt-2 border-t theme-border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4" style={{ color: 'var(--ok)' }} />
                <label className="text-xs font-semibold">Atomic Backup (All Notes.txt)</label>
              </div>
            </div>
            <p className="text-[11px] theme-muted leading-relaxed">
              Every change is written atomically to a single <code className="font-mono theme-raised px-1 py-0.5 rounded">All Notes.txt</code> next to the application executable with <code className="font-mono theme-raised px-1 py-0.5 rounded">====</code> dividers. The Restore action recovers missing notes without overwriting existing files.
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={handleRestoreBackup}
                disabled={isRestoring}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-medium transition-all duration-150 hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100"
                style={{ backgroundColor: 'color-mix(in srgb, var(--ok) 15%, transparent)', borderColor: 'color-mix(in srgb, var(--ok) 30%, transparent)', color: 'var(--ok)' }}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRestoring ? 'animate-spin' : ''}`} />
                <span>Restore Missing from Backup</span>
              </button>

              <button
                onClick={handleDownloadBackupTxt}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl btn-ghost border text-xs font-medium transition-all duration-150 hover:scale-105 active:scale-95"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export All Notes.txt</span>
              </button>

              <button
                onClick={handleOpenDataFolder}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl btn-ghost border text-xs font-medium transition-all duration-150 hover:scale-105 active:scale-95"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Open data folder</span>
              </button>

              <button
                onClick={handleExportAll}
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl btn-ghost border text-xs font-medium transition-all duration-150 hover:scale-105 active:scale-95"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export all as .md files</span>
              </button>
            </div>

            {backupNote && (
              <div className="p-3 rounded-xl border control-card text-xs flex items-start gap-2 animate-slide-in">
                <Info className="w-4 h-4 shrink-0 mt-0.5 theme-accent" />
                <span>{backupNote}</span>
              </div>
            )}

            {exportFeedback && (
              <div className="p-3 rounded-xl border control-card text-xs flex items-start gap-2 animate-slide-in">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--ok)' }} />
                <span>{exportFeedback}</span>
              </div>
            )}

            {restoreFeedback && (
              <div className="p-3 rounded-xl border control-card text-xs flex items-start gap-2 animate-slide-in">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--ok)' }} />
                <span>{restoreFeedback}</span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 border-t theme-border flex justify-end">
          <button
            onClick={close}
            className="px-5 py-2 rounded-xl btn-accent text-xs font-semibold shadow-md transition-all duration-150 hover:scale-105 active:scale-95"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
