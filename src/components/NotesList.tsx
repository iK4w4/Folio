import React, { useRef, useMemo, useEffect } from 'react';
import { Pin, Folder, FileText, SearchX, Plus, Trash2 } from 'lucide-react';
import { Note } from '../types/note';
import { getNoteDisplay, formatNoteDate, extractNoteTags } from '../lib/utils';

interface NotesListProps {
  notes: Note[];
  activeFileName: string | null;
  searchQuery: string;
  onSelectNote: (fileName: string) => void;
  onContextMenu: (e: React.MouseEvent, note: Note) => void;
  onDragStart: (e: React.DragEvent, note: Note) => void;
  currentFolder: string | null;
  onNewNoteInFolder?: () => void;
  isTrashScope?: boolean;
}

/** One compiled regex per query, shared across cards: String.split()
 * resets lastIndex before matching, so sharing a global regex is safe. */
let cachedHighlightQuery = '';
let cachedHighlightRe: RegExp | null = null;

function highlightRegex(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  if (q !== cachedHighlightQuery) {
    cachedHighlightQuery = q;
    cachedHighlightRe = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  }
  return cachedHighlightRe;
}

/** Wrap every occurrence of the (trimmed) query in a <mark>. */
function highlightMatch(text: string, query: string) {
  const re = highlightRegex(query);
  if (!re) return text;
  const q = query.trim();
  const parts = text.split(re);
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="bg-[var(--accent)]/25 text-[var(--text)] font-bold rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

const NoteCard = React.memo(function NoteCard({
  note,
  index,
  isActive,
  isTrashScope,
  searchQuery,
  onSelectNote,
  onContextMenu,
  onDragStart,
}: {
  note: Note;
  index: number;
  isActive: boolean;
  isTrashScope: boolean;
  searchQuery: string;
  onSelectNote: (fileName: string) => void;
  onContextMenu: (e: React.MouseEvent, note: Note) => void;
  onDragStart: (e: React.DragEvent, note: Note) => void;
}) {
  const { title, preview, isUntitled } = getNoteDisplay(note.content);
  const tags = useMemo(() => extractNoteTags(note.content), [note.content]);

  return (
    <div
      data-note-file={note.fileName}
      draggable={!isTrashScope}
      tabIndex={0}
      role="button"
      aria-pressed={isActive}
      onDragStart={(e) => onDragStart(e, note)}
      onClick={() => onSelectNote(note.fileName)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectNote(note.fileName);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, note);
      }}
      style={{ '--i': index } as React.CSSProperties}
      className={`group relative p-3 rounded-2xl cursor-pointer note-card focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:-outline-offset-2 ${
        isActive ? 'active' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          dir="auto"
          className={`text-xs font-semibold line-clamp-1 flex-1 leading-snug tracking-tight ${
            isUntitled
              ? 'theme-muted italic font-normal'
              : isActive
              ? 'theme-accent font-bold'
              : ''
          }`}
        >
          {highlightMatch(title, searchQuery)}
        </h3>
        {note.pinned && (
          <div className="w-4 h-4 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
            <Pin className="w-2.5 h-2.5 text-amber-500 fill-amber-500/30" />
          </div>
        )}
      </div>

      <p dir="auto" className="text-[11px] theme-muted line-clamp-2 mt-1.5 leading-relaxed">
        {highlightMatch(preview, searchQuery)}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px] theme-faint mt-2.5 font-mono tabular-nums">
        <span>{formatNoteDate(note.modifiedAt)}</span>
        {note.folder && (
          <>
            <span aria-hidden="true" className="opacity-40">·</span>
            <div className="flex items-center gap-1 truncate max-w-[110px]">
              <Folder className="w-2.5 h-2.5 opacity-70 theme-accent" />
              <span className="truncate">{note.folder}</span>
            </div>
          </>
        )}
        {tags.length > 0 && (
          <>
            <span aria-hidden="true" className="opacity-40">·</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {tags.slice(0, 3).map((tag) => (
                <span key={tag} className="theme-accent hover:underline">
                  #{tag}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

export const NotesList: React.FC<NotesListProps> = ({
  notes,
  activeFileName,
  searchQuery,
  onSelectNote,
  onContextMenu,
  onDragStart,
  currentFolder,
  onNewNoteInFolder,
  isTrashScope,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected note scrolled into view (keyboard arrows, restore).
  useEffect(() => {
    if (!activeFileName) return;
    const root = listRef.current;
    if (!root) return;
    // Look the card up by its data attribute: a file name may contain
    // characters that are invalid inside a CSS attribute selector (a quote
    // or a bracket), and querySelector() would throw on it.
    const cards = root.querySelectorAll<HTMLElement>('[data-note-file]');
    for (const card of cards) {
      if (card.dataset.noteFile === activeFileName) {
        card.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }, [notes, activeFileName]);

  if (notes.length === 0) {
    if (searchQuery.trim()) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none animate-fade-in">
          <div className="w-12 h-12 rounded-2xl glass flex items-center justify-center mb-3">
            <SearchX className="w-6 h-6 opacity-70 theme-accent" />
          </div>
          <p className="text-xs font-semibold theme-text">No notes found</p>
          <p className="text-[11px] theme-muted mt-1 max-w-[200px] leading-relaxed">
            No notes match &ldquo;<span className="theme-accent font-semibold">{searchQuery}</span>&rdquo;
          </p>
        </div>
      );
    }

    if (isTrashScope) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none animate-fade-in">
          <div className="w-12 h-12 rounded-2xl glass flex items-center justify-center theme-accent mb-3">
            <Trash2 className="w-6 h-6 opacity-70 theme-danger" />
          </div>
          <p className="text-xs font-semibold theme-text">Trash is empty</p>
          <p className="text-[11px] theme-muted mt-1 max-w-[220px] leading-relaxed">
            Deleted notes land here and can be restored. Anything in Trash is kept until you delete it forever.
          </p>
        </div>
      );
    }

    // The "No folder" scope is selectedFolder === '' — falsy, so a plain
    // truthiness check would mislabel it as "All notes".
    const scopeLabel = currentFolder === '' ? 'No folder' : currentFolder;
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none animate-fade-in">
        <div className="w-12 h-12 rounded-2xl glass flex items-center justify-center theme-accent mb-3">
          {currentFolder !== null ? <Folder className="w-6 h-6 opacity-80" /> : <FileText className="w-6 h-6 opacity-80" />}
        </div>
        <p className="text-xs font-semibold theme-text">
          {currentFolder !== null ? `"${scopeLabel}" is empty` : 'No notes yet'}
        </p>
        <p className="text-[11px] theme-muted mt-1 max-w-[210px] leading-relaxed">
          {currentFolder !== null
            ? `Write a note in "${scopeLabel}" or drag notes here to organize.`
            : 'Write your thoughts without titles or clutter. Everything autosaves.'}
        </p>

        {onNewNoteInFolder && (
          <button
            onClick={onNewNoteInFolder}
            className="mt-4 flex items-center gap-2 px-3.5 py-1.5 rounded-xl btn-accent font-medium text-xs shadow-md transition-all duration-150 hover:scale-105 active:scale-95"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{currentFolder !== null ? `New note in ${scopeLabel}` : 'New note (Ctrl+N)'}</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5 select-none relative">
      {notes.map((note, index) => {
        const isActive = note.fileName === activeFileName;
        return (
          <NoteCard
            key={note.fileName}
            note={note}
            index={index}
            isActive={isActive}
            isTrashScope={isTrashScope ?? false}
            searchQuery={searchQuery}
            onSelectNote={onSelectNote}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
          />
        );
      })}
    </div>
  );
};
