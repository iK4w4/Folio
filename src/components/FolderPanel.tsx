import React, { useState, useRef, useEffect } from 'react';
import { Folder, FolderPlus, Inbox, Archive, Check, Plus, X, Trash2 } from 'lucide-react';
import { Folder as FolderType } from '../types/note';

interface FolderPanelProps {
  isOpen: boolean;
  folders: FolderType[];
  selectedFolder: string | null;
  totalCount: number;
  unfiledCount: number;
  trashCount: number;
  isTrashScope: boolean;
  onSelectFolder: (folder: string | null) => void;
  onSelectTrash: () => void;
  onCreateFolder: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onFolderContextMenu: (e: React.MouseEvent, folderName: string) => void;
  onDropOnFolder: (folderName: string, fileNames: string[]) => void;
  createTrigger?: number;
}

// Drop sentinels that can never collide with a real folder name (a folder
// name cannot contain control characters).
const ALL_SENTINEL = '\u0000all';
const UNFILED_SENTINEL = '\u0000unfiled';

/**
 * Every row (All notes, No folder, each folder, Trash) is a single <button>:
 * icon + name + count chip. No nested buttons, no hover-reveal that swaps
 * the count for buttons — rename/delete live in the right-click menu.
 *
 * A single w-full button inside a plain flex column is exactly the
 * container width, so a row can never overflow its scroll container.
 */
export const FolderPanel: React.FC<FolderPanelProps> = ({
  isOpen,
  folders,
  selectedFolder,
  totalCount,
  unfiledCount,
  trashCount,
  isTrashScope,
  onSelectFolder,
  onSelectTrash,
  onCreateFolder,
  onFolderContextMenu,
  onDropOnFolder,
  createTrigger = 0,
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createError, setCreateError] = useState('');
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastTriggerRef = useRef(createTrigger);

  useEffect(() => {
    if (isCreating) {
      inputRef.current?.focus();
    }
  }, [isCreating]);

  useEffect(() => {
    if (createTrigger !== lastTriggerRef.current) {
      lastTriggerRef.current = createTrigger;
      setCreateError('');
      setIsCreating(true);
    }
  }, [createTrigger]);

  if (!isOpen) return null;

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newFolderName.trim();
    if (!clean) return;
    try {
      const result = await onCreateFolder(clean);
      if (result.ok) {
        setNewFolderName('');
        setCreateError('');
        setIsCreating(false);
      } else {
        setCreateError(result.error || 'Couldn’t create that folder. Try a different name.');
      }
    } catch (err) {
      // Show the real reason instead of leaving the form open with no
      // explanation.
      setCreateError(err instanceof Error ? err.message : 'Couldn’t create that folder.');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setIsCreating(false);
      setNewFolderName('');
      setCreateError('');
    }
  };

  const handleDragOver = (e: React.DragEvent, folderTarget: string) => {
    // Only note drags (application/json, set by the note list) highlight a
    // drop target — dragging files in from Explorer must not.
    if (!e.dataTransfer.types.includes('application/json')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverFolder !== folderTarget) {
      setDragOverFolder(folderTarget);
    }
  };

  const handleDragLeave = (e: React.DragEvent, folderTarget: string) => {
    // Moving onto an inner <span>/<svg> inside the row fires dragleave too —
    // the ring would flicker off on every hover.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (dragOverFolder === folderTarget) {
      setDragOverFolder(null);
    }
  };

  const handleDrop = (e: React.DragEvent, folderTarget: string) => {
    e.preventDefault();
    setDragOverFolder(null);
    try {
      const data = e.dataTransfer.getData('application/json');
      if (!data) return;
      const fileNames: unknown = JSON.parse(data);
      if (!Array.isArray(fileNames) || fileNames.length === 0) return;
      // Dropping on "All notes" is a no-op filter move, not a folder move:
      // it must not scatter notes to "".
      if (folderTarget === ALL_SENTINEL) {
        onSelectFolder(null);
        return;
      }
      const target = folderTarget === UNFILED_SENTINEL ? '' : folderTarget;
      onDropOnFolder(target, fileNames.filter((n): n is string => typeof n === 'string'));
    } catch (err) {
      console.warn('Drop error:', err);
    }
  };

  const countChip =
    'text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--glass)] border border-[var(--glass-border)] theme-faint font-mono tabular-nums shrink-0';

  // One class for every row (.folder-row in index.css). The selected shape
  // is a single inset ring, never a border plus an outer ring, and there is
  // no press-scale — selecting a row changes only the ring color.
  const rowClass = (isSelected: boolean) =>
    `folder-row w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left ${
      isSelected ? 'selected' : 'theme-text'
    }`;

  // min-w-0 on the label side lets a long name truncate instead of pushing
  // the count (and the row) wider.
  const rowLabel = 'flex items-center gap-2 min-w-0 truncate';

  return (
    <div className="panel-solid relative z-10 p-2.5 mx-2 my-2 shrink-0 text-xs select-none !rounded-2xl">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold theme-text text-[11px] uppercase tracking-wider">Folders</span>
          <span className={countChip}>{folders.length}</span>
        </div>
        {!isCreating && (
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg btn-ghost theme-accent border border-[var(--glass-border)] text-[11px] font-medium transition-all duration-150 hover:scale-105 active:scale-95"
            title="Create a new folder"
          >
            <Plus className="w-3 h-3 theme-accent" />
            <span>New folder</span>
          </button>
        )}
      </div>

      {isCreating && (
        <form
          onSubmit={handleCreateSubmit}
          className="mb-2 p-1.5 rounded-xl glass flex flex-col gap-1"
        >
          <div className="flex items-center gap-1.5">
            <FolderPlus className="w-4 h-4 theme-accent ml-1.5 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={newFolderName}
              onChange={(e) => {
                setNewFolderName(e.target.value);
                if (createError) setCreateError('');
              }}
              onKeyDown={handleKeyDown}
              placeholder="Folder name... (Enter to save)"
              className="flex-1 min-w-0 bg-transparent border-none text-xs placeholder:text-[var(--faint)] outline-none px-1 selection:bg-[var(--accent)] selection:text-[var(--accent-text)]"
            />
            <button
              type="submit"
              disabled={!newFolderName.trim()}
              className="p-1 rounded-lg btn-accent disabled:opacity-40 transition-all hover:scale-105 active:scale-95 shrink-0"
              title="Create folder"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setIsCreating(false);
                setNewFolderName('');
                setCreateError('');
              }}
              className="p-1 rounded-lg theme-faint hover:text-[var(--text)] transition-all hover:scale-105 active:scale-95 shrink-0"
              title="Cancel (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {createError && (
            <p className="text-[11px] theme-danger px-1.5 pb-0.5">{createError}</p>
          )}
        </form>
      )}

      {/* Plain column: overflow-x-hidden so a row can never be cut on the
          right, overflow-y-auto only when the list is taller than max-h-56. */}
      <div className="flex flex-col gap-1 max-h-56 overflow-y-auto overflow-x-hidden pr-1">
        {/* All notes — a valid drop target (no-op move back to the filter). */}
        <button
          onClick={() => onSelectFolder(null)}
          onDragOver={(e) => handleDragOver(e, ALL_SENTINEL)}
          onDragLeave={(e) => handleDragLeave(e, ALL_SENTINEL)}
          onDrop={(e) => handleDrop(e, ALL_SENTINEL)}
          className={`${rowClass(selectedFolder === null && !isTrashScope)} ${
            dragOverFolder === ALL_SENTINEL ? 'drag-over' : ''
          }`}
        >
          <span className={rowLabel}>
            <Archive className="w-3.5 h-3.5 shrink-0 theme-accent" />
            <span className="truncate">All notes</span>
          </span>
          <span className={countChip}>{totalCount}</span>
        </button>

        <button
          onClick={() => onSelectFolder('')}
          onDragOver={(e) => handleDragOver(e, UNFILED_SENTINEL)}
          onDragLeave={(e) => handleDragLeave(e, UNFILED_SENTINEL)}
          onDrop={(e) => handleDrop(e, UNFILED_SENTINEL)}
          className={`${rowClass(selectedFolder === '' && !isTrashScope)} ${
            dragOverFolder === UNFILED_SENTINEL ? 'drag-over' : ''
          }`}
        >
          <span className={rowLabel}>
            <Inbox className="w-3.5 h-3.5 shrink-0 text-amber-500" />
            <span className="truncate">No folder</span>
          </span>
          <span className={countChip}>{unfiledCount}</span>
        </button>

        {folders.map((f) => {
          const isSelected = selectedFolder === f.name && !isTrashScope;
          const isDragTarget = dragOverFolder === f.name;
          return (
            <button
              key={f.name}
              onClick={() => onSelectFolder(f.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                onFolderContextMenu(e, f.name);
              }}
              onDragOver={(e) => handleDragOver(e, f.name)}
              onDragLeave={(e) => handleDragLeave(e, f.name)}
              onDrop={(e) => handleDrop(e, f.name)}
              title="Right-click to rename or delete"
              className={`${rowClass(isSelected)} ${isDragTarget ? 'drag-over' : ''}`}
            >
              <span className={rowLabel}>
                <Folder
                  className={`w-3.5 h-3.5 shrink-0 transition-colors ${
                    isSelected ? 'theme-accent' : 'theme-faint'
                  }`}
                />
                <span className="truncate">{f.name}</span>
              </span>
              <span className={countChip}>{f.count}</span>
            </button>
          );
        })}

        {folders.length === 0 && !isCreating && (
          <div className="py-2 px-1 text-center theme-faint text-[11px]">
            No custom folders yet. Click{' '}
            <button className="theme-accent hover:underline font-semibold" onClick={() => setIsCreating(true)}>
              New folder
            </button>{' '}
            above.
          </div>
        )}

        {/* Trash lives inside the panel, so the whole sidebar list is one
            aligned column. */}
        <div className="my-1 border-t border-[var(--glass-border)]" aria-hidden="true" />
        <button
          onClick={onSelectTrash}
          title="Trash — deleted notes, restorable"
          className={rowClass(isTrashScope)}
        >
          <span className={rowLabel}>
            <Trash2 className="w-3.5 h-3.5 shrink-0 theme-danger" />
            <span className="truncate">Trash</span>
          </span>
          <span className={countChip}>{trashCount}</span>
        </button>
      </div>
    </div>
  );
};
