import React, { useState, useEffect, useRef } from 'react';
import { Trash2, Edit3, X, Info } from 'lucide-react';

export interface ConfirmDialogState {
  isOpen: boolean;
  type: 'delete-note' | 'delete-folder' | 'rename-folder' | 'delete-forever' | 'empty-trash' | 'info';
  title: string;
  message: string;
  confirmLabel: string;
  isDestructive?: boolean;
  targetFileName?: string;
  targetFolder?: string;
  initialValue?: string;
}

interface ConfirmModalProps {
  dialog: ConfirmDialogState;
  onConfirm: (inputValue?: string) => void | Promise<void>;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  dialog,
  onConfirm,
  onCancel,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Element that opened the dialog — focus returns to it on close.
  const triggerRef = useRef<HTMLElement | null>(null);
  // Latest cancel callback: the key handler below subscribes once per open
  // instead of re-subscribing on every parent render.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  // Only capture the trigger on the closed -> open transition. The effect
  // re-runs when the dialog type flips (e.g. delete fails and App turns it
  // into an 'info' dialog while it stays open) — capturing then would store
  // a button INSIDE this dialog, which unmounts, breaking focus restoration.
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = dialog.isOpen;
    if (dialog.isOpen) {
      if (!wasOpen) {
        triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      setIsSubmitting(false);
      setInputValue(dialog.initialValue || '');
      if (dialog.type === 'rename-folder') {
        const t = setTimeout(() => inputRef.current?.focus(), 50);
        return () => clearTimeout(t);
      }
      // Non-rename dialogs: move focus into the dialog itself, so the Tab
      // trap below starts inside it. Without this, focus stays on the
      // (now unmounted) trigger and the first Tab walks the app behind
      // the dialog instead of cycling its buttons.
      dialogRef.current?.focus();
    }
    return;
  }, [dialog.isOpen, dialog.type, dialog.initialValue]);

  // Focus restore: when the dialog closes, focus goes back to the element
  // that opened it instead of staying on the background.
  useEffect(() => {
    if (!dialog.isOpen && triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [dialog.isOpen]);

  // Trap focus inside the dialog while open: keep Tab from escaping to
  // the background app, and restore focus to the trigger on close.
  useEffect(() => {
    if (!dialog.isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onCancelRef.current();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current || !dialogRef.current.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Capture phase: the Settings modal underneath registers its Escape
    // listener first, so in bubble phase it would run first and close
    // itself under this dialog before stopImmediatePropagation could run.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [dialog.isOpen]);

  if (!dialog.isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSubmitting) return;
    // Enter submits the form even though the Save button is disabled on an
    // empty name — bail out quietly instead of cycling isSubmitting with no
    // feedback.
    if (dialog.type === 'rename-folder' && !inputValue.trim()) return;
    // The caller awaits async IPC (delete/rename/empty-trash); a fast
    // double-click would otherwise invoke it twice, and the second call
    // fails against the already-deleted target.
    setIsSubmitting(true);
    const done = () => setIsSubmitting(false);
    try {
      const result: unknown =
        dialog.type === 'rename-folder'
          ? inputValue.trim()
            ? onConfirm(inputValue.trim())
            : undefined
          : onConfirm();
      const thenable = result as { then?: unknown } | null | undefined;
      if (thenable && typeof thenable.then === 'function') {
        (thenable as Promise<void>).then(done, done);
      } else {
        done();
      }
    } catch {
      done();
    }
  };

  const isInfo = dialog.type === 'info';
  const chipStyle = dialog.isDestructive
    ? { backgroundColor: 'color-mix(in srgb, var(--danger) 15%, transparent)', borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)' }
    : { backgroundColor: 'color-mix(in srgb, var(--accent) 15%, transparent)', borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' };

  return (
    <div
      ref={backdropRef}
      onClick={(e) => {
        if (e.target === backdropRef.current) onCancel();
      }}
      className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/50 animate-fade-in select-none"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        className="glass-strong w-full max-w-sm rounded-2xl p-6 animate-modal-in flex flex-col"
      >
        {/* Header Icon + Title */}
        <div className="flex items-start gap-3">
          <div
            className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border shadow-md animate-scale-in"
            style={chipStyle}
          >
            {dialog.isDestructive ? (
              <Trash2 className="w-5 h-5" style={{ color: 'var(--danger)' }} />
            ) : isInfo ? (
              <Info className="w-5 h-5 theme-accent" />
            ) : (
              <Edit3 className="w-5 h-5 theme-accent" />
            )}
          </div>

          <div className="flex-1 pr-1">
            <h3 id="confirm-modal-title" className="text-sm font-bold theme-text">{dialog.title}</h3>
            <p id="confirm-modal-message" className="text-xs theme-muted mt-1 leading-relaxed whitespace-pre-line">
              {dialog.message}
            </p>
          </div>

          <button
            onClick={onCancel}
            className="p-1 rounded-lg btn-ghost theme-faint hover:text-[var(--text)] transition-all hover:scale-105 active:scale-95"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Input field if renaming */}
        {dialog.type === 'rename-folder' && (
          <form onSubmit={handleSubmit} className="mt-4">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Enter new folder name..."
              className="w-full bg-[var(--bg)]/40 border control-border rounded-xl px-3 py-2 text-xs theme-text outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30 transition-all shadow-inner"
            />
          </form>
        )}

        {/* Action Buttons */}
        <div className="mt-5 pt-3.5 border-t theme-border flex items-center justify-end gap-2">
          {!isInfo && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              className="btn-ghost px-4 py-2 rounded-xl text-xs font-medium transition-all duration-150 hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              Cancel
            </button>
          )}

          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={isSubmitting || (dialog.type === 'rename-folder' && !inputValue.trim())}
            style={dialog.isDestructive ? { backgroundColor: 'var(--danger)', color: 'var(--danger-text)', borderColor: 'var(--danger)' } : undefined}
            className={`px-4 py-2 rounded-xl text-xs font-semibold shadow-md transition-all duration-150 hover:scale-105 hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 ${
              dialog.isDestructive
                ? 'border border-[var(--danger)]'
                : 'btn-accent'
            }`}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
