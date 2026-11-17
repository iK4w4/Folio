import React, { useEffect, useRef } from 'react';
import { X, Send, HardDrive, Zap, Lock } from 'lucide-react';
import { isTauri } from '../lib/storage';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Element that opened the dialog — focus returns to it on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  // Only capture the trigger on the closed -> open transition.
  const wasOpenRef = useRef(false);
  // Latest close callback: the key handler below subscribes once per open
  // instead of re-subscribing on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      // Trap Tab inside the dialog while open. The containment check keeps
      // this inert when focus sits in a dialog stacked above this one.
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
  }, [isOpen]);

  if (!isOpen) return null;

  const handleOpenTelegram = async () => {
    if (isTauri()) {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl('https://t.me/AskKawaBot');
        return;
      } catch (err) {
        console.warn('Tauri opener failed, falling back to window.open:', err);
      }
    }
    window.open('https://t.me/AskKawaBot', '_blank', 'noopener,noreferrer');
  };

  const codeChip =
    'font-mono bg-[var(--glass)] border border-[var(--glass-border)] px-1 py-0.5 rounded theme-text';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="About Folio"
        className="glass-strong w-full max-w-md rounded-2xl p-6 select-none animate-modal-in flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b theme-border">
          <div className="flex items-center gap-2">
            <img src="/folio-icon.png" alt="Folio" className="w-6 h-6 rounded-md shadow-sm" />
            <h2 className="text-sm font-bold theme-text">About Folio</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg btn-ghost theme-faint hover:text-[var(--text)] transition-all hover:scale-105 active:scale-95"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="py-5 space-y-4 text-xs theme-text leading-relaxed">
          <div className="p-4 rounded-2xl glass text-center">
            <h3 className="text-base font-bold theme-text tracking-tight bg-gradient-to-r from-[var(--text)] to-[var(--muted)] bg-clip-text text-transparent">Folio</h3>
            <p className="text-xs theme-accent font-semibold mt-1">Created by iK4w4</p>
            <p className="text-[11px] theme-muted font-mono mt-1">v{__APP_VERSION__}</p>
            <p className="text-[11px] theme-muted mt-2">
              Fast, portable notes for Windows — your notes as plain .md files, with Folio color themes and frosted glass.
            </p>
          </div>

          <div className="space-y-3 pt-1">
            <div className="flex items-start gap-2.5">
              <HardDrive className="w-4 h-4 theme-accent shrink-0 mt-0.5" />
              <span>You own your notes. Plain <code className={codeChip}>.md</code> files stored in <code className={codeChip}>Notes/</code> next to the executable.</span>
            </div>
            <div className="flex items-start gap-2.5">
              <Lock className="w-4 h-4" style={{ color: 'var(--ok)' }} />
              <span>100% offline, private, zero telemetry, no accounts or cloud dependencies.</span>
            </div>
            <div className="flex items-start gap-2.5">
              <Zap className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <span>Instant typing, burst-aware undo/redo, atomic backup to <code className={codeChip}>All Notes.txt</code>.</span>
            </div>
          </div>
        </div>

        {/* Footer Support Button */}
        <div className="pt-4 border-t theme-border flex items-center justify-between gap-3">
          <button
            onClick={handleOpenTelegram}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl btn-accent font-semibold text-xs shadow-lg transition-all duration-150 hover:scale-[1.02] active:scale-95"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Support: @AskKawaBot</span>
          </button>
          <button
            onClick={onClose}
            className="btn-ghost py-2.5 px-4 rounded-xl text-xs font-medium transition-all duration-150 hover:scale-105 active:scale-95"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
