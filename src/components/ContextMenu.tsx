import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pin, PinOff, FolderInput, Copy, Trash2, Edit2, Files, Download, RotateCcw } from 'lucide-react';
import { Folder } from '../types/note';

interface ContextMenuProps {
  isOpen: boolean;
  x: number;
  y: number;
  type: 'note' | 'folder' | 'trash-note';
  targetFileName?: string;
  targetFolder?: string;
  isPinned?: boolean;
  folders: Folder[];
  onClose: () => void;
  onPinToggle?: (fileName: string) => void;
  onDuplicateNote?: (fileName: string) => void;
  onExportNote?: (fileName: string) => void;
  onMoveToFolder?: (fileName: string, folderName: string) => void;
  onCopyContent?: (fileName: string) => void;
  onDeleteNote?: (fileName: string) => void;
  onRestoreNote?: (fileName: string) => void;
  onDeleteForever?: (fileName: string) => void;
  onRenameFolder?: (oldName: string) => void;
  onDeleteFolder?: (folderName: string) => void;
}

const ITEM =
  'flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98] w-full';

const MENU_WIDTH = 210;
const SUB_WIDTH = 192;

export const ContextMenu: React.FC<ContextMenuProps> = ({
  isOpen,
  x,
  y,
  type,
  targetFileName,
  targetFolder,
  isPinned,
  folders,
  onClose,
  onPinToggle,
  onDuplicateNote,
  onExportNote,
  onMoveToFolder,
  onCopyContent,
  onDeleteNote,
  onRestoreNote,
  onDeleteForever,
  onRenameFolder,
  onDeleteFolder,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showFolderSubmenu, setShowFolderSubmenu] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeRef.current();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setShowFolderSubmenu(false);
  }, [isOpen]);

  // Measure the rendered menu and clamp it inside the viewport (no hardcoded
  // heights that drift when items are added).
  useLayoutEffect(() => {
    if (!isOpen || !menuRef.current) {
      setPos(null);
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const px = Math.max(8, Math.min(x, vw - rect.width - 12));
    const py = Math.max(8, Math.min(y, vh - rect.height - 12));
    setPos({ x: px, y: py });
  }, [isOpen, x, y]);

  if (!isOpen) return null;

  const px = pos?.x ?? Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 12));
  const py = pos?.y ?? Math.max(8, Math.min(y, window.innerHeight - 300 - 12));

  // The submenu flips to the left when there is no room on the right. The
  // wrapper carries the 6px bridge as padding (not margin), so the pointer
  // never leaves a hovered element while crossing to the submenu.
  const submenuWrap =
    px + MENU_WIDTH + 8 + SUB_WIDTH > window.innerWidth
      ? `right-full pr-1.5`
      : `left-full pl-1.5`;

  // Escape is handled by the outer window listener, but the submenu needs
  // its own dismissal so keyboard users can step out of it first.
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && showFolderSubmenu) {
      e.stopPropagation();
      setShowFolderSubmenu(false);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      onKeyDown={handleMenuKeyDown}
      style={{
        position: 'fixed',
        left: `${px}px`,
        top: `${py}px`,
        zIndex: 99999,
      }}
      className="glass-menu w-52 p-1.5 text-xs select-none animate-menu-in"
      role="menu"
      aria-label="Context menu"
    >
      {type === 'trash-note' && targetFileName && (
        <div className="flex flex-col gap-0.5">
          {onRestoreNote && (
            <button
              className={ITEM}
              onClick={() => {
                onRestoreNote(targetFileName);
                onClose();
              }}
            >
              <RotateCcw className="w-4 h-4 theme-muted" />
              <span>Restore note</span>
            </button>
          )}
          {onDeleteForever && (
            <button
              className={`${ITEM} theme-danger hover:bg-[var(--danger)]/10`}
              onClick={() => {
                onDeleteForever(targetFileName);
                onClose();
              }}
            >
              <Trash2 className="w-4 h-4 theme-danger" />
              <span>Delete forever</span>
            </button>
          )}
        </div>
      )}

      {type === 'note' && targetFileName && (
        <div className="flex flex-col gap-0.5">
          {onPinToggle && (
            <button
              onClick={() => {
                onPinToggle(targetFileName);
                onClose();
              }}
              className={ITEM}
            >
              {isPinned ? <PinOff className="w-4 h-4 text-amber-500" /> : <Pin className="w-4 h-4 theme-muted" />}
              <span>{isPinned ? 'Unpin note' : 'Pin to top'}</span>
            </button>
          )}

          {onDuplicateNote && (
            <button
              onClick={() => {
                onDuplicateNote(targetFileName);
                onClose();
              }}
              className={ITEM}
            >
              <Files className="w-4 h-4 theme-muted" />
              <span>Duplicate note</span>
            </button>
          )}

          {onCopyContent && (
            <button
              onClick={() => {
                onCopyContent(targetFileName);
                onClose();
              }}
              className={ITEM}
            >
              <Copy className="w-4 h-4 theme-muted" />
              <span>Copy markdown</span>
            </button>
          )}

          {onExportNote && (
            <button
              onClick={() => {
                onExportNote(targetFileName);
                onClose();
              }}
              className={ITEM}
            >
              <Download className="w-4 h-4 theme-muted" />
              <span>Export note (.md)</span>
            </button>
          )}

          {onMoveToFolder && (
            <div
              className="relative"
              onMouseEnter={() => setShowFolderSubmenu(true)}
              onMouseLeave={() => setShowFolderSubmenu(false)}
              // Keyboard users Tab out of the submenu into the next item:
              // close it once focus leaves this wrapper, so it never stays
              // open over the item below it.
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setShowFolderSubmenu(false);
                }
              }}
            >
              <button
                className={`${ITEM} justify-between`}
                onFocus={() => setShowFolderSubmenu(true)}
                // Open-only, never a toggle: hover already opens the submenu,
                // so a toggle would close it on the very click that should
                // open it for touch / click users.
                onClick={() => setShowFolderSubmenu(true)}
              >
                <div className="flex items-center gap-2.5">
                  <FolderInput className="w-4 h-4 theme-muted" />
                  <span>Move to folder</span>
                </div>
                <span className="text-[10px] opacity-50">▶</span>
              </button>

              {showFolderSubmenu && (
                <div className={`absolute ${submenuWrap} top-0 z-50`}>
                  <div className="w-48 glass-menu p-1.5 flex flex-col gap-0.5 animate-menu-in max-h-64 overflow-y-auto">
                  <button
                    onClick={() => {
                      onMoveToFolder(targetFileName, '');
                      onClose();
                    }}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-[var(--raised)] text-left text-xs transition-all duration-100 active:scale-[0.98]"
                  >
                    <span>Root (No folder)</span>
                  </button>
                  {folders.map((f) => (
                    <button
                      key={f.name}
                      onClick={() => {
                        onMoveToFolder(targetFileName, f.name);
                        onClose();
                      }}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded-xl hover:bg-[var(--raised)] text-left text-xs truncate transition-all duration-100 active:scale-[0.98]"
                    >
                      <span className="truncate">{f.name}</span>
                      <span className="text-[10px] theme-faint font-mono">{f.count}</span>
                    </button>
                  ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="my-1 border-t theme-border" />

          {onDeleteNote && (
            <button
              onClick={() => {
                onDeleteNote(targetFileName);
                onClose();
              }}
              className={`${ITEM} theme-danger hover:bg-[var(--danger)]/10`}
            >
              <Trash2 className="w-4 h-4 theme-danger" />
              <span>Move to Trash</span>
            </button>
          )}
        </div>
      )}

      {type === 'folder' && targetFolder && (
        <div className="flex flex-col gap-0.5">
          {onRenameFolder && (
            <button
              onClick={() => {
                onRenameFolder(targetFolder);
                onClose();
              }}
              className={ITEM}
            >
              <Edit2 className="w-4 h-4 theme-muted" />
              <span>Rename folder</span>
            </button>
          )}

          {onDeleteFolder && (
            <button
              onClick={() => {
                onDeleteFolder(targetFolder);
                onClose();
              }}
              className={`${ITEM} theme-danger hover:bg-[var(--danger)]/10`}
            >
              <Trash2 className="w-4 h-4 theme-danger" />
              <span>Delete folder</span>
            </button>
          )}
        </div>
      )}
    </div>,
    document.body
  );
};
