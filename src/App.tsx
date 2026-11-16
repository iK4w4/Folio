import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, Folder as FolderIcon, ArrowUpDown, Plus, X, ChevronDown, Check } from 'lucide-react';
import { Note, Folder, SortMode, AppSettings, ContextMenuState } from './types/note';
import { applyTheme } from './lib/themes';
import { getNoteDisplay, safeClipboardCopy } from './lib/utils';
import {
  fetchNotes,
  createNote,
  saveNote,
  deleteNote,
  moveNotes,
  togglePinNote,
  fetchFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  fetchSettings,
  persistSettings,
  setWindowZoom,
  fetchTrash,
  restoreNote,
  deleteNotePermanent,
  emptyTrash,
  exportNote,
  exportAllNotes,
  duplicateNote,
  isTauri,
} from './lib/storage';
import { TitleBar } from './components/TitleBar';
import { FolderPanel } from './components/FolderPanel';
import { NotesList } from './components/NotesList';
import { Editor } from './components/Editor';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ContextMenu } from './components/ContextMenu';
import { SettingsModal } from './components/SettingsModal';
import { AboutModal } from './components/AboutModal';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { ConfirmModal, ConfirmDialogState } from './components/ConfirmModal';

// Selected-folder sentinel for the Trash scope. Kept as a constant so it
// can never collide with a real folder name in filter logic.
const TRASH_SCOPE = '\u0000trash';
// Sentinels for the two "no folder selected" scopes. "All notes" is
// selectedFolder === null and "No folder" is selectedFolder === '' — both
// are falsy, so they need distinct, collision-proof scope keys. A NUL byte
// can never appear in a folder name (the backend rejects control
// characters), so these can never collide with a real folder.
const ALL_SCOPE = '\u0000all';
const ROOT_SCOPE = '\u0000root';

/** The notes of `pool` that belong to the given scope. */
function notesInScope(pool: Note[], scope: string): Note[] {
  if (scope === TRASH_SCOPE || scope === ALL_SCOPE) return pool;
  if (scope === ROOT_SCOPE) return pool.filter((n) => !n.folder || n.folder === '');
  return pool.filter((n) => n.folder === scope);
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [trash, setTrash] = useState<Note[]>([]);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  // Default sort is 'created' (by creation time, newest first). Creation
  // time never changes on edit, so the list order stays stable while
  // working on a note.
  const [sortMode, setSortMode] = useState<SortMode>('created');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [isFolderPanelOpen, setIsFolderPanelOpen] = useState(false);
  const [folderCreateTrigger, setFolderCreateTrigger] = useState(0);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    type: 'delete-note',
    title: '',
    message: '',
    confirmLabel: 'Delete',
    isDestructive: true,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    type: 'note',
  });

  const [settings, setSettings] = useState<AppSettings>({
    theme: 'dark',
    palette: 'forest',
    zoom: 100,
    editorFontFamily: 'system',
    uiBold: false,
    spellCheck: true,
    lineNumbers: false,
    glassiness: 70,
    editorFontSize: 14,
  });

  const [isFocusMode, setIsFocusMode] = useState(false);
  const [dataError, setDataError] = useState<string>('');
  // A save that failed after the user moved on to another note: the editor
  // reports failures for the note on screen itself, so this banner is the
  // only place a switch-flush failure can surface. It always names the
  // note the save actually failed for, never the one now open.
  const [failedSave, setFailedSave] = useState<{ fileName: string; error: string } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  // The sort dropdown renders in a portal: the panel's glass
  // backdrop-filter creates a stacking context and the FolderPanel / note
  // cards below would paint over an inline menu. A portal escapes the
  // sidebar entirely, so the menu always paints above everything, clamped
  // inside the viewport.
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const sortPortalRef = useRef<HTMLDivElement>(null);
  const [sortMenuPos, setSortMenuPos] = useState<{ x: number; y: number } | null>(null);
  const notesRef = useRef(notes);
  const trashRef = useRef(trash);
  const activeFileNameRef = useRef(activeFileName);
  const selectedFolderRef = useRef(selectedFolder);
  notesRef.current = notes;
  trashRef.current = trash;
  activeFileNameRef.current = activeFileName;
  selectedFolderRef.current = selectedFolder;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;
  // The zoom shortcuts read settingsRef.current, so the ref must be
  // updated synchronously — a repeat press before the re-render would
  // otherwise read a stale zoom.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshReqRef = useRef(0);
  // Epoch (ms) of the newest optimistic note edit. A refresh that started
  // BEFORE that edit may return pre-edit list state — its notes are skipped
  // (folders/trash still apply).
  const lastEditRef = useRef(0);
  const refreshLists = useCallback(async () => {
    const reqId = ++refreshReqRef.current;
    const startedAt = Date.now();
    try {
      const [fetchedNotes, fetchedFolders, fetchedTrash] = await Promise.all([
        fetchNotes(),
        fetchFolders(),
        fetchTrash(),
      ]);
      // A newer refresh superseded this one — drop the stale response so a
      // slow fetch cannot resurrect old list state.
      if (refreshReqRef.current !== reqId) return null;
      // A local edit happened after this refresh started — the fetched
      // notes may pre-date it. Keep the optimistic state (it IS the newer
      // one); folders and trash still apply.
      if (lastEditRef.current <= startedAt) {
        setNotes(fetchedNotes);
      }
      setFolders(fetchedFolders);
      setTrash(fetchedTrash);
      setDataError('');
      return { fetchedNotes, fetchedFolders, fetchedTrash };
    } catch (err) {
      if (refreshReqRef.current !== reqId) return null;
      const msg = err instanceof Error ? err.message : String(err);
      setDataError(msg);
      console.error('refreshLists failed:', err);
      return null;
    }
  }, []);

  // Initial load — runs once. Refreshes afterwards are explicit (creates,
  // deletes, moves) rather than effects keyed on the active note.
  useEffect(() => {
    (async () => {
      try {
        const fetchedSettings = await fetchSettings();
        setSettings(fetchedSettings);
        const result = await refreshLists();
        if (result && result.fetchedNotes.length > 0) {
          setActiveFileName(result.fetchedNotes[0]?.fileName ?? null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDataError(msg);
        console.error('initial load failed:', err);
      }
    })();
  }, [refreshLists]);

  // The editor must always show a note that is INSIDE the current scope
  // (All notes / No folder / a folder / Trash). A scope switch opens the
  // first note of the new scope (or an explicitly requested one — a
  // restored note), and a note that disappears from the scope falls back to
  // the first note still in it.
  const scopeKey =
    selectedFolder === TRASH_SCOPE
      ? TRASH_SCOPE
      : selectedFolder === null
        ? ALL_SCOPE
        : selectedFolder === ''
          ? ROOT_SCOPE
          : selectedFolder;
  const scopeKeyRef = useRef(scopeKey);
  // Set when a specific note must be opened by the next scope switch
  // (restore / duplicate / new note in a folder).
  const pendingActiveRef = useRef<string | null>(null);

  useEffect(() => {
    const pool = selectedFolder === TRASH_SCOPE ? trash : notes;
    const inScope = notesInScope(pool, scopeKey);
    const scopeChanged = scopeKeyRef.current !== scopeKey;
    scopeKeyRef.current = scopeKey;

    if (scopeChanged) {
      const preferred = pendingActiveRef.current;
      pendingActiveRef.current = null;
      const next =
        preferred && inScope.some((n) => n.fileName === preferred)
          ? preferred
          : inScope[0]?.fileName ?? null;
      if (next !== activeFileName) setActiveFileName(next);
      return;
    }

    if (!activeFileName) {
      // A pending "open this exact note" request only matters for the scope
      // switch it was made for — drop it so it cannot pick a note later.
      pendingActiveRef.current = null;
      return;
    }
    if (!inScope.some((n) => n.fileName === activeFileName)) {
      setActiveFileName(inScope[0]?.fileName ?? null);
    }
    pendingActiveRef.current = null;
  }, [notes, trash, activeFileName, selectedFolder, scopeKey]);

  // Apply the color theme and zoom separately so toggling a palette does
  // not force a WebView zoom call, and dragging the zoom slider does not
  // repaint the entire theme token set.
  useEffect(() => {
    applyTheme(settings.palette || 'forest', settings.theme, settings.glassiness);
  }, [settings.palette, settings.theme, settings.glassiness]);

  // ui-bold lives on <html> so portals (modals, context menus) mounted on
  // document.body get bold UI text too.
  useEffect(() => {
    document.documentElement.classList.toggle('ui-bold', settings.uiBold === true);
  }, [settings.uiBold]);

  useEffect(() => {
    if (settings.zoom >= 90 && settings.zoom <= 150) {
      void setWindowZoom(settings.zoom);
    }
  }, [settings.zoom]);

  const handleUpdateSettings = useCallback(async (newSettings: AppSettings) => {
    // Sync the ref NOW — the zoom keys read settingsRef.current.
    settingsRef.current = newSettings;
    setSettings(newSettings);
    const ok = await persistSettings(newSettings);
    if (!ok) {
      showInfoRef.current(
        'Settings Not Saved',
        'The settings could not be written to disk. They apply for this session and are saved again the next time you change a setting.'
      );
    }
  }, []);

  // Live UI-only update for slider drags; the debounced persist runs after.
  const handlePreviewSettings = useCallback((newSettings: AppSettings) => {
    settingsRef.current = newSettings;
    setSettings(newSettings);
  }, []);

  const flushBeforeClose = useCallback(async () => {
    try {
      await editorControlsRef.current?.flush();
    } catch {
      // A failed flush must not block the window from closing.
    }
    try {
      settingsFlushRef.current?.();
    } catch {
      // Same: closing wins over a lost slider tick.
    }
  }, []);

  const handleRequestClose = useCallback(async () => {
    await flushBeforeClose();
    if (isTauri()) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    }
  }, [flushBeforeClose]);

  // Alt+F4 / OS close button: Tauri routes the close through here first.
  // preventDefault + flush + destroy, so a save started <500ms before the
  // close is not cut off by the WebView teardown. (destroy needs
  // core:window:allow-destroy in capabilities/default.json.)
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let destroyed = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          if (destroyed) return;
          event.preventDefault();
          await flushBeforeClose();
          destroyed = true;
          await getCurrentWindow().destroy();
        });
      } catch {
        // Window API unavailable (browser preview) — nothing to hook.
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [flushBeforeClose]);

  // Global browser-menu suppression (app ships its own menus).
  useEffect(() => {
    const killBrowserMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', killBrowserMenu);
    return () => document.removeEventListener('contextmenu', killBrowserMenu);
  }, []);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The portal menu lives outside sortMenuRef, so check both.
      if (
        sortMenuRef.current && !sortMenuRef.current.contains(target) &&
        !(sortPortalRef.current && sortPortalRef.current.contains(target))
      ) {
        setIsSortMenuOpen(false);
      }
    };
    if (isSortMenuOpen) window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, [isSortMenuOpen]);

  // Measure the sort button and clamp the portal menu inside the viewport.
  // Re-measured on open (and on resize while open) so the menu never hangs
  // off the bottom edge and "Oldest" is never clipped.
  useLayoutEffect(() => {
    if (!isSortMenuOpen || !sortButtonRef.current) {
      setSortMenuPos(null);
      return;
    }
    const measure = () => {
      const btn = sortButtonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuW = 144; // w-36
      // 4 sort options + padding, with headroom for long labels.
      const menuH = 168;
      const x = Math.max(8, Math.min(rect.right - menuW, window.innerWidth - menuW - 8));
      const y = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menuH - 8));
      setSortMenuPos({ x, y });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isSortMenuOpen]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    // A malformed date makes Date.parse return NaN and breaks .sort().
    const timeOf = (d: string) => {
      const t = Date.parse(d);
      return Number.isFinite(t) ? t : 0;
    };
    // Search haystacks are built once per list, over the scope-filtered
    // notes only, with a separator between fields so a query can never
    // match across a field boundary (content "ab" + file "c…" is not "abc").
    const matchesQuery = (pool: Note[]) => {
      const haystacks = new Map<Note, string>();
      for (const n of pool) {
        haystacks.set(
          n,
          `${(n.content || '').toLowerCase()}\n${n.fileName.toLowerCase()}\n${(n.folder || '').toLowerCase()}`
        );
      }
      return (n: Note) => (haystacks.get(n) ?? '').includes(q);
    };
    // Decorate once: times and (for A–Z) titles are computed per note, not
    // per comparison — stripping Markdown inside the comparator is
    // O(n log n) stripping work on every keystroke and save.
    const decorate = (pool: Note[]) =>
      pool.map((n) => ({
        note: n,
        created: timeOf(n.createdAt),
        modified: timeOf(n.modifiedAt),
        title: sortMode === 'az' ? getNoteDisplay(n.content).title.toLowerCase() : '',
      }));

    if (selectedFolder === TRASH_SCOPE) {
      let result = [...trash];
      if (q) result = result.filter(matchesQuery(result));
      const decorated = decorate(result);
      decorated.sort((a, b) => b.modified - a.modified || a.note.fileName.localeCompare(b.note.fileName));
      return decorated.map((d) => d.note);
    }

    let result = [...notes];
    if (selectedFolder === '') {
      result = result.filter((n) => !n.folder || n.folder === '');
    } else if (selectedFolder !== null) {
      result = result.filter((n) => n.folder === selectedFolder);
    }
    if (q) result = result.filter(matchesQuery(result));
    const decorated = decorate(result);
    decorated.sort((a, b) => {
      if (a.note.pinned && !b.note.pinned) return -1;
      if (!a.note.pinned && b.note.pinned) return 1;
      if (sortMode === 'created') return b.created - a.created || a.note.fileName.localeCompare(b.note.fileName);
      if (sortMode === 'newest') return b.modified - a.modified || a.note.fileName.localeCompare(b.note.fileName);
      if (sortMode === 'oldest') return a.modified - b.modified || a.note.fileName.localeCompare(b.note.fileName);
      return a.title.localeCompare(b.title) || b.note.createdAt.localeCompare(a.note.createdAt);
    });
    return decorated.map((d) => d.note);
  }, [notes, trash, selectedFolder, searchQuery, sortMode]);

  const activeNote = useMemo(() => {
    if (selectedFolder === TRASH_SCOPE) {
      return trash.find((n) => n.fileName === activeFileName) || null;
    }
    return notes.find((n) => n.fileName === activeFileName) || null;
  }, [notes, trash, activeFileName, selectedFolder]);

  const totalNotesCount = notes.length;
  const unfiledNotesCount = notes.filter((n) => !n.folder || n.folder === '').length;
  const isTrashScope = selectedFolder === TRASH_SCOPE;
  // The banner names the failed note by its title when it is still in the
  // list, and by file name when it is not.
  const failedSaveNote = failedSave ? notes.find((n) => n.fileName === failedSave.fileName) : undefined;
  const failedSaveLabel = failedSave
    ? failedSaveNote
      ? getNoteDisplay(failedSaveNote.content).title
      : failedSave.fileName
    : '';

  const handleNewNote = useCallback(async () => {
    try {
      const scope = selectedFolderRef.current;
      // Notes created while browsing "All notes" or Trash still go to the
      // root, but the view must NOT jump to "No folder" when the user is
      // just browsing everything.
      const targetFolder = scope === null || scope === TRASH_SCOPE ? '' : scope;
      const newNote = await createNote('', targetFolder);
      setNotes((prev) => [newNote, ...prev]);
      setActiveFileName(newNote.fileName);
      // When the scope changes to the target folder, the scope effect opens
      // the first note of that scope — make sure it is the note that was
      // just created.
      pendingActiveRef.current = newNote.fileName;
      if (scope === TRASH_SCOPE) {
        setSelectedFolder(null);
      } else if (targetFolder) {
        setSelectedFolder(targetFolder);
      }
      void refreshLists();
    } catch (err) {
      showInfoRef.current('New Note Failed', err instanceof Error ? err.message : 'Could not create a new note.');
    }
  }, [refreshLists]);

  const handleDuplicateNote = useCallback(
    async (fileName: string) => {
      try {
        const target = notesRef.current.find((n) => n.fileName === fileName);
        if (!target) return;
        const duplicated = await duplicateNote(target);
        setNotes((prev) => [duplicated, ...prev]);
        setActiveFileName(duplicated.fileName);
        pendingActiveRef.current = duplicated.fileName;
        // Follow the copy into its folder instead of snapping the view.
        const scopeNow = selectedFolderRef.current;
        if (duplicated.folder && scopeNow !== duplicated.folder) setSelectedFolder(duplicated.folder);
        void refreshLists();
      } catch (err) {
        showInfoRef.current('Duplicate Failed', err instanceof Error ? err.message : 'Could not duplicate that note.');
      }
    },
    [refreshLists]
  );

  const showInfo = useCallback((title: string, message: string) => {
    setConfirmDialog({
      isOpen: true,
      type: 'info',
      title,
      message,
      confirmLabel: 'OK',
      isDestructive: false,
    });
  }, []);

  const showInfoRef = useRef(showInfo);
  showInfoRef.current = showInfo;

  const handleExportNote = useCallback(
    async (fileName: string) => {
      try {
        const path = await exportNote(fileName);
        showInfo('Note Exported', `Saved a copy to:\n${path}`);
      } catch (err) {
        showInfo('Export Failed', err instanceof Error ? err.message : 'Could not export that note.');
      }
    },
    [showInfo]
  );

  const handleExportAll = useCallback(async () => {
    try {
      const msg = await exportAllNotes();
      showInfo('All Notes Exported', msg);
    } catch (err) {
      showInfo('Export Failed', err instanceof Error ? err.message : 'Could not export notes.');
    }
  }, [showInfo]);

  // Optimistic save — the UI never loses text, the disk write is reported
  // separately.
  const handleSaveContent = useCallback(
    async (fileName: string, content: string): Promise<{ ok: boolean; error?: string }> => {
      const folder = notesRef.current.find((n) => n.fileName === fileName)?.folder ?? '';
      // Whether the note is still on screen decides who reports a failure:
      // the editor shows its own status for the open note, so the app only
      // records failures for a save that finished after the user moved on
      // (a switch flush the editor has already forgotten). Captured now,
      // not when the write resolves — by then the user may have switched
      // back, and the failure would be misattributed to the open note.
      const wasActiveAtCall = fileName === activeFileNameRef.current;
      lastEditRef.current = Date.now();
      setNotes((prev) =>
        prev.map((n) => (n.fileName === fileName ? { ...n, content, modifiedAt: new Date().toISOString() } : n))
      );
      const result = await saveNote(fileName, content, folder);
      if (result.ok) {
        setFailedSave((prev) => (prev && prev.fileName === fileName ? null : prev));
      } else if (!wasActiveAtCall || fileName !== activeFileNameRef.current) {
        setFailedSave({ fileName, error: result.error || 'The disk write failed.' });
      }
      return result;
    },
    []
  );

  const handleRetryFailedSave = useCallback(async () => {
    if (!failedSave) return;
    const note = notesRef.current.find((n) => n.fileName === failedSave.fileName);
    // The note is gone (deleted since the failure) — nothing to retry.
    if (!note) {
      setFailedSave(null);
      return;
    }
    await handleSaveContent(note.fileName, note.content);
  }, [failedSave, handleSaveContent]);

  // The delete / restore / empty handlers REPORT whether they succeeded.
  // The confirm dialog needs to know: it must stay open when the action
  // failed, so the user can read why.
  const handleDeleteNote = useCallback(
    async (fileName: string): Promise<boolean> => {
      try {
        const ok = await deleteNote(fileName);
        if (!ok) {
          showInfoRef.current('Delete Failed', 'Could not move that note to Trash.');
          return false;
        }
        const current = notesRef.current;
        const scope = selectedFolderRef.current;
        // Stay inside the visible scope: the note next to the deleted one
        // in the FULL list may live in another folder, and the scope effect
        // would then yank the editor to the scope's first note instead of
        // the neighbour.
        const inScope = (n: Note) =>
          scope === null ||
          (scope === '' ? !n.folder || n.folder === '' : n.folder === scope);
        const deletedIndex = current.filter(inScope).findIndex((n) => n.fileName === fileName);
        const next = current.filter((n) => n.fileName !== fileName);
        setNotes(next);
        setFailedSave((prev) => (prev && prev.fileName === fileName ? null : prev));
        if (activeFileNameRef.current === fileName) {
          // Stay next to the deleted note instead of jumping to the top of
          // the list.
          const scopedNext = next.filter(inScope);
          const adjacent = scopedNext[deletedIndex] ?? scopedNext[deletedIndex - 1] ?? null;
          setActiveFileName(adjacent?.fileName ?? null);
        }
        void refreshLists();
        return true;
      } catch (err) {
        showInfoRef.current('Delete Failed', err instanceof Error ? err.message : 'Could not move that note to Trash.');
        return false;
      }
    },
    [refreshLists]
  );

  const handleRestoreNote = useCallback(
    async (fileName: string): Promise<boolean> => {
      try {
        const ok = await restoreNote(fileName);
        if (!ok) {
          showInfoRef.current('Restore Failed', 'Could not restore that note.');
          return false;
        }
        const restored = trashRef.current.find((n) => n.fileName === fileName);
        setTrash((prev) => prev.filter((n) => n.fileName !== fileName));
        if (restored) {
          setNotes((prev) => [restored, ...prev]);
          setActiveFileName(restored.fileName);
          // The scope may change to the restored note's folder — make sure
          // the scope effect opens THAT note, not the first one in the
          // folder.
          pendingActiveRef.current = restored.fileName;
          // Restored notes land in their original folder; a root note
          // belongs to the "No folder" scope (empty string), not "All notes".
          setSelectedFolder(restored.folder || '');
        }
        void refreshLists();
        return true;
      } catch (err) {
        showInfoRef.current('Restore Failed', err instanceof Error ? err.message : 'Could not restore that note (a note with the same name may already exist).');
        return false;
      }
    },
    [refreshLists]
  );

  const handleDeleteForever = useCallback(async (fileName: string): Promise<boolean> => {
    try {
      const ok = await deleteNotePermanent(fileName);
      if (!ok) {
        showInfoRef.current('Delete Failed', 'Could not delete that note forever.');
        return false;
      }
      setTrash((prev) => prev.filter((n) => n.fileName !== fileName));
      if (activeFileNameRef.current === fileName) {
        const pool = selectedFolderRef.current === TRASH_SCOPE ? trashRef.current : notesRef.current;
        setActiveFileName(pool.find((n) => n.fileName !== fileName)?.fileName ?? null);
      }
      return true;
    } catch (err) {
      showInfoRef.current('Delete Failed', err instanceof Error ? err.message : 'Could not delete that note forever.');
      return false;
    }
  }, []);

  const handleEmptyTrash = useCallback(async (): Promise<boolean> => {
    try {
      const ok = await emptyTrash();
      if (!ok) {
        showInfoRef.current('Empty Trash Failed', 'Could not empty the Trash.');
        return false;
      }
      setTrash([]);
      if (activeFileNameRef.current && trashRef.current.some((n) => n.fileName === activeFileNameRef.current)) {
        setActiveFileName(notesRef.current[0]?.fileName ?? null);
        setSelectedFolder(null);
      }
      return true;
    } catch (err) {
      showInfoRef.current('Empty Trash Failed', err instanceof Error ? err.message : 'Could not empty the Trash.');
      return false;
    }
  }, []);

  // "Delete forever" from the Trash context menu goes through the same
  // confirmation as the Trash banner — one click must not destroy a note
  // permanently with no way back.
  const handleRequestDeleteForever = useCallback((fileName: string) => {
    const target = trashRef.current.find((n) => n.fileName === fileName);
    const firstLine = target ? (target.content.split('\n')[0] ?? '').trim() : '';
    const snippet = firstLine ? (firstLine.length > 32 ? firstLine.slice(0, 32) + '...' : firstLine) : 'this note';
    setConfirmDialog({
      isOpen: true,
      type: 'delete-forever',
      title: 'Delete Forever',
      message: `Permanently delete "${snippet}"? This cannot be undone.`,
      confirmLabel: 'Delete Forever',
      isDestructive: true,
      targetFileName: fileName,
    });
  }, []);

  const handleRequestDeleteNote = useCallback(
    (fileName: string) => {
      const target = notesRef.current.find((n) => n.fileName === fileName);
      const firstLine = target ? (target.content.split('\n')[0] ?? '').trim() : '';
      const snippet = firstLine || 'this note';
      setConfirmDialog({
        isOpen: true,
        type: 'delete-note',
        title: 'Move to Trash',
        message: `Move "${snippet.length > 32 ? snippet.slice(0, 32) + '...' : snippet}" to Trash? You can restore it from Trash later.`,
        confirmLabel: 'Move to Trash',
        isDestructive: true,
        targetFileName: fileName,
      });
    },
    []
  );

  const handleMoveSingleNote = useCallback(
    async (fileName: string, targetFolder: string) => {
      try {
        const ok = await moveNotes([fileName], targetFolder);
        if (ok) {
          setNotes((prev) =>
            prev.map((n) => (n.fileName === fileName ? { ...n, folder: targetFolder, modifiedAt: new Date().toISOString() } : n))
          );
        }
      } catch (err) {
        showInfoRef.current('Move Failed', err instanceof Error ? err.message : 'Could not move that note.');
      }
      void refreshLists();
    },
    [refreshLists]
  );

  const handlePinToggle = useCallback(async (fileName: string) => {
    const current = notesRef.current.find((n) => n.fileName === fileName);
    if (!current) return;
    const next = !current.pinned;
    try {
      const ok = await togglePinNote(fileName, next);
      if (ok) {
        setNotes((prev) => prev.map((n) => (n.fileName === fileName ? { ...n, pinned: next } : n)));
      } else {
        showInfoRef.current('Pin Failed', 'Could not update that note.');
      }
    } catch (err) {
      showInfoRef.current('Pin Failed', err instanceof Error ? err.message : 'Could not pin that note.');
    }
  }, []);

  const handleCreateFolder = useCallback(
    async (folderName: string): Promise<{ ok: boolean; error?: string }> => {
      // Windows folders are case-insensitive: "work" next to "Work" is the
      // same directory, but the backend's registry check is case-sensitive,
      // so it would register both and the panel would show two rows for one
      // folder. An exact-case repeat stays idempotent (backend Ok(true) —
      // the folder is just selected).
      const clean = folderName.trim();
      if (
        clean &&
        foldersRef.current.some(
          (f) => f.name.toLowerCase() === clean.toLowerCase() && f.name !== clean
        )
      ) {
        return { ok: false, error: 'A folder with that name already exists.' };
      }
      try {
        const result = await createFolder(folderName);
        if (!result.ok) return result;
        setFolders(await fetchFolders());
        setSelectedFolder(result.name ?? folderName.trim());
        setIsFolderPanelOpen(true);
        return { ok: true };
      } catch (err) {
        // never let a thrown error escape as an unhandled rejection
        // — the panel shows the reason instead.
        return { ok: false, error: err instanceof Error ? err.message : 'Could not create that folder.' };
      }
    },
    []
  );

  const handleRenameFolder = useCallback((oldName: string) => {
    setConfirmDialog({
      isOpen: true,
      type: 'rename-folder',
      title: 'Rename Folder',
      message: `Enter a new name for "${oldName}":`,
      confirmLabel: 'Save Name',
      isDestructive: false,
      targetFolder: oldName,
      initialValue: oldName,
    });
  }, []);

  const handleDeleteFolder = useCallback((folderName: string) => {
    setConfirmDialog({
      isOpen: true,
      type: 'delete-folder',
      title: 'Delete Folder',
      message: `Delete folder "${folderName}"? Notes inside will be moved to No folder.`,
      confirmLabel: 'Delete Folder',
      isDestructive: true,
      targetFolder: folderName,
    });
  }, []);

  const handleConfirmAction = useCallback(
    async (inputValue?: string) => {
      if (confirmDialog.type === 'info') {
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
        return;
      }
      // `raised` tracks that a failure message is on screen. The dialog
      // only closes when the action succeeded — a failure must stay visible
      // so the user can read why. renameFolder / deleteFolder throw with
      // the real backend reason, so they are caught here.
      let raised = false;
      const fail = (title: string, message: string) => {
        raised = true;
        showInfoRef.current(title, message);
      };
      try {
        if (confirmDialog.type === 'delete-folder' && confirmDialog.targetFolder) {
          const folderName = confirmDialog.targetFolder;
          const ok = await deleteFolder(folderName, false);
          if (ok) {
            setNotes((prev) => prev.map((n) => (n.folder === folderName ? { ...n, folder: '' } : n)));
            setFolders(await fetchFolders());
            if (selectedFolderRef.current === folderName) setSelectedFolder(null);
            void refreshLists();
          } else {
            fail('Delete Folder Failed', 'Could not delete that folder.');
          }
        } else if (confirmDialog.type === 'rename-folder' && confirmDialog.targetFolder && inputValue) {
          const oldName = confirmDialog.targetFolder;
          const newName = inputValue.trim();
          if (newName && newName !== oldName) {
            const ok = await renameFolder(oldName, newName);
            if (ok) {
              setNotes((prev) => prev.map((n) => (n.folder === oldName ? { ...n, folder: newName } : n)));
              setFolders(await fetchFolders());
              if (selectedFolderRef.current === oldName) setSelectedFolder(newName);
              void refreshLists();
            } else {
              fail('Rename Failed', 'Could not rename that folder.');
            }
          }
        } else if (confirmDialog.type === 'delete-note' && confirmDialog.targetFileName) {
          const ok = await handleDeleteNote(confirmDialog.targetFileName);
          if (!ok) raised = true;
        } else if (confirmDialog.type === 'delete-forever' && confirmDialog.targetFileName) {
          const ok = await handleDeleteForever(confirmDialog.targetFileName);
          if (!ok) raised = true;
        } else if (confirmDialog.type === 'empty-trash') {
          const ok = await handleEmptyTrash();
          if (!ok) raised = true;
        }
      } catch (err) {
        fail(
          'Action Failed',
          err instanceof Error ? err.message : 'The action could not be completed.'
        );
      } finally {
        // Only close the dialog when it did not turn into an error message.
        if (!raised) setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      }
    },
    [confirmDialog, handleDeleteNote, handleDeleteForever, handleEmptyTrash, refreshLists]
  );

  // Single selection only — clicking a note just opens it.
  const handleSelectNote = useCallback((fileName: string) => {
    setActiveFileName(fileName);
  }, []);

  const handleDragStart = useCallback(
    (e: React.DragEvent, note: Note) => {
      e.dataTransfer.setData('application/json', JSON.stringify([note.fileName]));
      e.dataTransfer.effectAllowed = 'move';
    },
    []
  );

  const handleDropOnFolder = useCallback(
    async (targetFolder: string, droppedFileNames: string[]) => {
      const notesByName = new Map(notesRef.current.map((n) => [n.fileName, n]));
      const toMove = droppedFileNames.filter((f) => {
        const note = notesByName.get(f);
        return note && (note.folder || '') !== targetFolder;
      });
      if (toMove.length === 0) return;
      const toMoveSet = new Set(toMove);
      try {
        const ok = await moveNotes(toMove, targetFolder);
        if (ok) {
          setNotes((prev) =>
            prev.map((n) =>
              toMoveSet.has(n.fileName)
                ? { ...n, folder: targetFolder, modifiedAt: new Date().toISOString() }
                : n
            )
          );
        }
      } catch (err) {
        showInfoRef.current('Move Failed', err instanceof Error ? err.message : 'Could not move those notes.');
      }
      void refreshLists();
    },
    [refreshLists]
  );

  const handleNoteContextMenu = useCallback(
    (e: React.MouseEvent, note: Note) => {
      // In the Trash the note-scoped actions (pin / duplicate / move-to-
      // folder / delete) do not make sense — the real actions there are
      // restore / delete-forever, so the menu adapts to the scope.
      const inTrash = selectedFolderRef.current === TRASH_SCOPE;
      setActiveFileName(note.fileName);
      setContextMenu({
        isOpen: true,
        x: e.clientX,
        y: e.clientY,
        type: inTrash ? 'trash-note' : 'note',
        targetFileName: note.fileName,
        targetFolder: undefined,
      });
    },
    []
  );

  const handleFolderContextMenu = useCallback((e: React.MouseEvent, folderName: string) => {
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      type: 'folder',
      targetFolder: folderName,
      targetFileName: undefined,
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
  }, []);

  const handleCopyContent = useCallback(
    async (fileName: string) => {
      const target = notesRef.current.find((n) => n.fileName === fileName);
      if (target) {
        await safeClipboardCopy(target.content);
      }
    },
    []
  );

  // Global shortcuts. Typing contexts (inputs, textarea, contenteditable,
  // open modals) are excluded so Ctrl-style keys never hijack the editor.
  // The context menu is an open overlay like a modal: its keys (Esc) are
  // owned by the menu itself, and app-level shortcuts must not fire behind it.
  const anyModalOpen = isSettingsOpen || isAboutOpen || isShortcutsOpen || confirmDialog.isOpen || contextMenu.isOpen;
  const editorControlsRef = useRef<{
    flush: () => Promise<void>;
    togglePreview: () => void;
  } | null>(null);
  const settingsFlushRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const isTyping = (el: Element | null) =>
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      (el instanceof HTMLElement && el.isContentEditable);

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (anyModalOpen) return;
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      // These are WINDOW-level shortcuts and must work even while the
      // editor has the focus.
      if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void handleNewNote();
        return;
      }
      if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        // In focus mode the sidebar is unmounted, so focus would have
        // nowhere to land — exit focus mode first, then focus after the
        // re-render remounts the search input.
        if (isFocusMode) setIsFocusMode(false);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return;
      }
      if (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsFocusMode((v) => !v);
        return;
      }
      if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        editorControlsRef.current?.togglePreview();
        return;
      }
      if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'p') {
        // preventDefault FIRST: otherwise the WebView's native Print dialog
        // opens. Pinning is a live-note action; Trash has its own
        // restore/delete.
        e.preventDefault();
        if (selectedFolderRef.current === TRASH_SCOPE) return;
        if (activeFileNameRef.current) {
          void handlePinToggle(activeFileNameRef.current);
        }
        return;
      }
      if (isCtrlOrCmd && !e.shiftKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        void handleUpdateSettings({ ...settingsRef.current, zoom: Math.min(150, settingsRef.current.zoom + 10) });
        return;
      }
      if (isCtrlOrCmd && !e.shiftKey && e.key === '-') {
        e.preventDefault();
        void handleUpdateSettings({ ...settingsRef.current, zoom: Math.max(90, settingsRef.current.zoom - 10) });
        return;
      }
      if (isCtrlOrCmd && !e.shiftKey && e.key === '0') {
        e.preventDefault();
        void handleUpdateSettings({ ...settingsRef.current, zoom: 100 });
        return;
      }

      if (isTyping(document.activeElement)) {
        // Escape still leaves focus mode even from nested controls.
        if (e.key === 'Escape' && isFocusMode) setIsFocusMode(false);
        // Escape in the search input clears the query.
        if (e.key === 'Escape' && document.activeElement === searchInputRef.current && searchQuery) {
          setSearchQuery('');
        }
        return;
      }
      if (!isCtrlOrCmd && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (filteredNotes.length > 0) {
          e.preventDefault();
          const currentIndex = filteredNotes.findIndex((n) => n.fileName === activeFileNameRef.current);
          let nextIndex = 0;
          if (e.key === 'ArrowUp') {
            nextIndex = currentIndex <= 0 ? filteredNotes.length - 1 : currentIndex - 1;
          } else {
            nextIndex = currentIndex === -1 || currentIndex >= filteredNotes.length - 1 ? 0 : currentIndex + 1;
          }
          const nextNote = filteredNotes[nextIndex];
          if (nextNote) {
            setActiveFileName(nextNote.fileName);
          }
          return;
        }
      }
      if (e.key === 'Escape') {
        if (isFocusMode) {
          setIsFocusMode(false);
          return;
        }
        if (contextMenu.isOpen) {
          setContextMenu((prev) => ({ ...prev, isOpen: false }));
          return;
        }
        if (isSortMenuOpen) {
          setIsSortMenuOpen(false);
          return;
        }
        if (searchQuery) {
          setSearchQuery('');
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [
    anyModalOpen,
    isFocusMode,
    filteredNotes,
    handleNewNote,
    handlePinToggle,
    handleUpdateSettings,
    contextMenu.isOpen,
    isSortMenuOpen,
    searchQuery,
  ]);

  const sortOptions: { id: SortMode; label: string }[] = [
    { id: 'created', label: 'Created' },
    { id: 'newest', label: 'Newest' },
    { id: 'oldest', label: 'Oldest' },
    { id: 'az', label: 'A – Z' },
  ];

  return (
    <ErrorBoundary>
      <div
        className={`w-screen h-screen flex flex-col overflow-hidden relative select-none font-sans theme-bg transition-colors duration-200 ${isFocusMode ? 'focus-mode' : ''} ${settings.uiBold ? 'ui-bold' : ''}`}
      >
        <div className="aurora" aria-hidden="true" />

        <TitleBar
          onNewNote={handleNewNote}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenAbout={() => setIsAboutOpen(true)}
          onOpenShortcuts={() => setIsShortcutsOpen(true)}
          onRequestClose={handleRequestClose}
        />

        <div className="flex-1 flex overflow-hidden relative z-10">
          {!isFocusMode && (
            <aside className="w-72 lg:w-80 h-full flex flex-col shrink-0">
              <div className="mx-2 mt-2 p-2.5 glass-panel !rounded-2xl shrink-0 space-y-2 relative z-20">
                <div className="relative flex items-center">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 theme-faint pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search notes... (Ctrl+F)"
                    className="w-full bg-[var(--bg)]/40 border control-border rounded-xl pl-8 pr-7 py-1.5 text-xs placeholder:text-[var(--faint)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all selection:bg-[var(--accent)] selection:text-[var(--accent-text)]"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 theme-faint hover:text-[var(--text)] transition-all hover:scale-110 active:scale-95 rounded-md"
                      aria-label="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-1 text-xs">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setIsFolderPanelOpen(!isFolderPanelOpen)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl transition-all duration-150 border hover:scale-105 active:scale-95 ${
                        isFolderPanelOpen
                          ? 'border-[var(--accent)] theme-accent font-semibold bg-[var(--raised)] shadow-[0_0_0_1px_var(--accent)]'
                          : 'btn-ghost theme-muted hover:text-[var(--text)]'
                      }`}
                      title="Toggle Folders Drawer"
                    >
                      <FolderIcon className="w-3.5 h-3.5 theme-accent" />
                      <span>Folders</span>
                      <span className="text-[10px] opacity-70 font-mono">({folders.length})</span>
                    </button>
                    <button
                      onClick={() => {
                        setIsFolderPanelOpen(true);
                        setFolderCreateTrigger((t) => t + 1);
                      }}
                      className="p-1.5 rounded-xl btn-ghost theme-muted hover:text-[var(--text)] transition-all duration-150 hover:scale-110 active:scale-95 border"
                      title="Create new folder"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="relative" ref={sortMenuRef}>
                    <button
                      ref={sortButtonRef}
                      onClick={() => setIsSortMenuOpen(!isSortMenuOpen)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl btn-ghost theme-muted hover:text-[var(--text)] transition-all duration-150 hover:scale-105 active:scale-95 text-xs border"
                      title="Sort notes list"
                    >
                      <ArrowUpDown className="w-3 h-3 theme-faint" />
                      <span className="capitalize">{sortMode === 'az' ? 'A – Z' : sortMode}</span>
                      <ChevronDown
                        className={`w-3 h-3 opacity-60 transition-transform duration-150 ${isSortMenuOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                  </div>
                  {isSortMenuOpen && createPortal(
                    <div
                      ref={sortPortalRef}
                      style={{
                        position: 'fixed',
                        left: `${sortMenuPos?.x ?? 8}px`,
                        top: `${sortMenuPos?.y ?? 8}px`,
                        zIndex: 99999,
                      }}
                      className="w-36 glass-menu p-1 flex flex-col gap-0.5 animate-menu-in"
                    >
                      {sortOptions.map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => {
                            setSortMode(opt.id);
                            setIsSortMenuOpen(false);
                          }}
                          className={`flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs transition-all duration-100 active:scale-[0.98] ${
                            sortMode === opt.id
                              ? 'theme-accent font-semibold bg-[var(--raised)]'
                              : 'hover:bg-[var(--raised)]'
                          }`}
                        >
                          <span>{opt.label}</span>
                          {sortMode === opt.id && <Check className="w-3 h-3 theme-accent" />}
                        </button>
                      ))}
                    </div>,
                    document.body
                  )}
                </div>
              </div>

              <FolderPanel
                isOpen={isFolderPanelOpen}
                folders={folders}
                selectedFolder={selectedFolder}
                totalCount={totalNotesCount}
                unfiledCount={unfiledNotesCount}
                trashCount={trash.length}
                isTrashScope={isTrashScope}
                onSelectFolder={(folder) => setSelectedFolder(folder)}
                onSelectTrash={() => setSelectedFolder(TRASH_SCOPE)}
                onCreateFolder={handleCreateFolder}
                onFolderContextMenu={handleFolderContextMenu}
                onDropOnFolder={handleDropOnFolder}
                createTrigger={folderCreateTrigger}
              />

              <NotesList
                notes={filteredNotes}
                activeFileName={activeFileName}
                searchQuery={searchQuery}
                onSelectNote={handleSelectNote}
                onContextMenu={handleNoteContextMenu}
                onDragStart={handleDragStart}
                currentFolder={selectedFolder}
                onNewNoteInFolder={handleNewNote}
                isTrashScope={isTrashScope}
              />
            </aside>
          )}

          <div className="flex-1 flex flex-col overflow-hidden editor-wrap">
            {dataError && (
              <div className="mx-3 mt-2.5 px-4 py-2 rounded-2xl text-xs animate-slide-in shrink-0"
                style={{
                  background: 'var(--glass-strong)',
                  border: '1px solid color-mix(in srgb, var(--danger) 30%, var(--glass-border))',
                  color: 'var(--text)',
                }}>
                <span className="theme-danger font-medium">Couldn't load notes — {dataError}</span>{' '}
                <button onClick={() => void refreshLists()} className="underline underline-offset-2">Retry</button>
              </div>
            )}
            {failedSave && (
              <div className="mx-3 mt-2.5 px-4 py-2 rounded-2xl text-xs animate-slide-in shrink-0"
                style={{
                  background: 'var(--glass-strong)',
                  border: '1px solid color-mix(in srgb, var(--danger) 30%, var(--glass-border))',
                  color: 'var(--text)',
                }}>
                <span className="theme-danger font-medium">Couldn't save &ldquo;{failedSaveLabel}&rdquo; — {failedSave.error}</span>{' '}
                <span>Your text is kept in the app.</span>{' '}
                <button onClick={() => void handleRetryFailedSave()} className="underline underline-offset-2">Retry</button>{' '}
                <button onClick={() => setFailedSave(null)} className="underline underline-offset-2">Dismiss</button>
              </div>
            )}
            <Editor
              note={activeNote}
              folders={folders}
              settings={settings}
              isTrashView={isTrashScope}
              isFocusMode={isFocusMode}
              onToggleFocus={() => setIsFocusMode((v) => !v)}
              onSaveContent={handleSaveContent}
              onPinToggle={handlePinToggle}
              onMoveToFolder={handleMoveSingleNote}
              onDeleteNote={handleRequestDeleteNote}
              onNewNote={handleNewNote}
              onDuplicateNote={handleDuplicateNote}
              onExportNote={handleExportNote}
              onRestoreNote={handleRestoreNote}
              controlsRef={editorControlsRef}
              onDeleteForever={handleRequestDeleteForever}
              onEmptyTrash={() => {
                setConfirmDialog({
                  isOpen: true,
                  type: 'empty-trash',
                  title: 'Empty Trash',
                  message: `Permanently delete all ${trash.length} note${trash.length === 1 ? '' : 's'} in Trash? This cannot be undone.`,
                  confirmLabel: 'Empty Trash',
                  isDestructive: true,
                });
              }}
            />
          </div>
        </div>

        <ContextMenu
          isOpen={contextMenu.isOpen}
          x={contextMenu.x}
          y={contextMenu.y}
          type={contextMenu.type}
          targetFileName={contextMenu.targetFileName}
          targetFolder={contextMenu.targetFolder}
          isPinned={
            contextMenu.targetFileName
              ? notes.find((n) => n.fileName === contextMenu.targetFileName)?.pinned
              : false
          }
          folders={folders}
          onClose={handleCloseContextMenu}
          onPinToggle={handlePinToggle}
          onDuplicateNote={handleDuplicateNote}
          onExportNote={handleExportNote}
          onMoveToFolder={handleMoveSingleNote}
          onCopyContent={handleCopyContent}
          onDeleteNote={handleRequestDeleteNote}
          onRestoreNote={handleRestoreNote}
          onDeleteForever={handleRequestDeleteForever}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
        />

        <SettingsModal
          isOpen={isSettingsOpen}
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          onPreviewSettings={handlePreviewSettings}
          flushRef={settingsFlushRef}
          onClose={() => setIsSettingsOpen(false)}
          onRefreshNotes={() => void refreshLists()}
          onExportAll={handleExportAll}
        />

        <AboutModal isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />

        <KeyboardShortcutsModal isOpen={isShortcutsOpen} onClose={() => setIsShortcutsOpen(false)} />

        <ConfirmModal
          dialog={confirmDialog}
          onConfirm={handleConfirmAction}
          onCancel={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
        />
      </div>
    </ErrorBoundary>
  );
}
