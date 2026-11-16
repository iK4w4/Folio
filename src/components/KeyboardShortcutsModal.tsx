import React, { useEffect, useRef } from 'react';
import { X, Keyboard } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose,
}) => {
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

  const shortcuts = [
    { key: 'Ctrl + N', desc: 'Create new note' },
    { key: 'Ctrl + F', desc: 'Focus live search' },
    { key: 'Ctrl + P', desc: 'Pin / unpin active note' },
    { key: 'Ctrl + Shift + F', desc: 'Focus mode (hide sidebar, center editor)' },
    { key: 'Ctrl + E', desc: 'Toggle markdown preview' },
    { key: 'Ctrl + = / Ctrl + -', desc: 'Zoom UI in / out' },
    { key: 'Ctrl + 0', desc: 'Reset UI zoom to 100%' },
    { key: 'Ctrl + Z', desc: 'Burst-aware undo (in editor)' },
    { key: 'Ctrl + Y', desc: 'Burst-aware redo (in editor)' },
    { key: 'Ctrl + B', desc: 'Bold selected text (in editor)' },
    { key: 'Ctrl + I', desc: 'Italic selected text (in editor)' },
    { key: 'Ctrl + K', desc: 'Link selected text (in editor)' },
    { key: 'Ctrl + S', desc: 'Save note now' },
    { key: '↑ / ↓', desc: 'Navigate notes list' },
    { key: 'Tab', desc: 'Indent with 2 spaces' },
    { key: 'Esc', desc: 'Exit focus mode / clear search / close modal' },
  ];

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
        aria-label="Keyboard Shortcuts"
        className="glass-strong w-full max-w-md rounded-2xl p-6 select-none animate-modal-in flex flex-col"
      >
        <div className="flex items-center justify-between pb-3 border-b theme-border">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 theme-accent" />
            <h2 className="text-sm font-bold theme-text">Keyboard Shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg btn-ghost theme-faint hover:text-[var(--text)] transition-all hover:scale-105 active:scale-95"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 space-y-1.5 text-xs max-h-[60vh] overflow-y-auto">
          {shortcuts.map((sc) => (
            <div key={sc.key} className="flex items-center justify-between py-1.5 px-2.5 rounded-xl hover:bg-[var(--raised)] transition-colors duration-100">
              <span className="theme-text">{sc.desc}</span>
              <kbd className="glass-chip font-mono text-[11px] shadow-sm">
                {sc.key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="pt-3.5 border-t theme-border flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl btn-accent text-xs font-semibold shadow-md transition-all duration-150 hover:scale-105 active:scale-95"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
