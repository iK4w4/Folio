import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Undo2,
  Redo2,
  Eye,
  Edit3,
  Columns,
  Pin,
  PinOff,
  FolderInput,
  Trash2,
  Check,
  Loader2,
  Copy,
  Download,
  Sparkles,
  Scissors,
  ClipboardPaste,
  Maximize,
  Minimize,
  Files,
  Upload,
  AlertTriangle,
  RotateCcw,
  MoreHorizontal,
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code,
  SquareCode,
  Link2,
  Image,
  Minus,
} from 'lucide-react';
import { marked } from 'marked';
import { Note, Folder, AppSettings } from '../types/note';
import {
  calculateTextStats,
  extractNoteTags,
  sanitizeMarkdownHtml,
  safeClipboardCopy,
} from '../lib/utils';
import { EditorHistoryManager } from '../lib/history';
import { isTauri } from '../lib/storage';

marked.setOptions({
  gfm: true,
  breaks: true,
});

interface EditorProps {
  note: Note | null;
  folders: Folder[];
  settings: AppSettings;
  isTrashView?: boolean;
  isFocusMode?: boolean;
  onToggleFocus?: () => void;
  onSaveContent: (fileName: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  onPinToggle: (fileName: string) => void;
  onMoveToFolder: (fileName: string, targetFolder: string) => void;
  onDeleteNote: (fileName: string) => void;
  onNewNote: () => void;
  onDuplicateNote?: (fileName: string) => void;
  onExportNote?: (fileName: string) => void;
  onRestoreNote?: (fileName: string) => void;
  onDeleteForever?: (fileName: string) => void;
  onEmptyTrash?: () => void;
  // App holds this ref: the window-level Ctrl+E toggle and the
  // close-time flush live in App, but the textarea + save timer live here.
  controlsRef?: {
    current: { flush: () => Promise<void>; togglePreview: () => void } | null;
  };
}

type ViewMode = 'edit' | 'preview' | 'split';

const AUTOSAVE_DEBOUNCE_MS = 500;

// Line bounds for the selection.
//
// start === 0 must not be treated as "lastIndexOf('\n', -1)", which clamps
// to 0 and would duplicate the leading newline. A selection ending exactly
// on a newline (Shift+Down) must not include the next line.
function getSelectedLineBounds(text: string, start: number, end: number) {
  const effectiveEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const lineEndIdx = text.indexOf('\n', effectiveEnd);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  return { lineStart, lineEnd };
}

// The line-number rows depend only on the line count. Kept in a
// memoized component so typing does not reconcile them on every
// keystroke: when the count is unchanged (typing inside a line, the
// common case), React bails out of the whole subtree instead of
// walking up to 5000 row elements per keystroke.
const GutterNumbers = React.memo(function GutterNumbers({ lineCount }: { lineCount: number }) {
  return (
    <>
      {Array.from({ length: lineCount }, (_, i) => (
        <div key={i + 1}>{i + 1}</div>
      ))}
    </>
  );
});

export const Editor: React.FC<EditorProps> = ({
  note,
  folders,
  settings,
  isTrashView,
  isFocusMode,
  onToggleFocus,
  onSaveContent,
  onPinToggle,
  onMoveToFolder,
  onDeleteNote,
  onNewNote,
  onDuplicateNote,
  onExportNote,
  onRestoreNote,
  onDeleteForever,
  onEmptyTrash,
  controlsRef,
}) => {
  const [content, setContent] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('edit');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'failed'>('saved');
  const [saveError, setSaveError] = useState<string>('');
  const [showFolderDropdown, setShowFolderDropdown] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [editorMenu, setEditorMenu] = useState<{ isOpen: boolean; x: number; y: number }>({
    isOpen: false,
    x: 0,
    y: 0,
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<EditorHistoryManager>(new EditorHistoryManager('', 0));
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentFileNameRef = useRef<string | null>(null);
  // The last content written to disk successfully. A blur with nothing
  // changed must not rewrite the file AND the whole All Notes.txt backup.
  const lastSavedRef = useRef<{ fileName: string; content: string } | null>(null);
  // The file that currently holds text that is NOT on disk yet. An external
  // content change (a refresh, a restore, the backup merge) must never
  // overwrite it — see the layout effect below.
  const dirtyFileRef = useRef<string | null>(null);
  // The switch-flush must know whether the PREVIOUS view was Trash, not the
  // incoming one — otherwise the flush is skipped when the user typed in a
  // live note and entered Trash within the 500ms autosave window.
  const wasTrashViewRef = useRef(isTrashView);
  // Monotonic version bumped on every autosave schedule; the async save
  // only reports status if it is still the latest save for its note.
  const saveVersionRef = useRef(0);
  const folderDropdownRef = useRef<HTMLDivElement>(null);
  // Portal menu: the folder dropdown renders in a portal because the
  // header's glass backdrop-filter creates a stacking context and the
  // editor text below would paint over an inline menu.
  const folderButtonRef = useRef<HTMLButtonElement>(null);
  const folderPortalRef = useRef<HTMLDivElement>(null);
  const [folderMenuPos, setFolderMenuPos] = useState<{ x: number; y: number } | null>(null);
  // "More" overflow menu: the header keeps only folder, pin, view mode and
  // undo/redo; every other action lives in this portal menu, and stats +
  // save status live in the footer.
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const morePortalRef = useRef<HTMLDivElement>(null);
  const [moreMenuPos, setMoreMenuPos] = useState<{ x: number; y: number } | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  // The mount-only unmount cleanup must call the CURRENT onSaveContent
  // without re-running the effect when the callback identity changes.
  const onSaveContentRef = useRef(onSaveContent);
  onSaveContentRef.current = onSaveContent;

  const closeEditorMenu = useCallback(() => {
    setEditorMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // the note is adopted in a LAYOUT effect, not a passive effect.
  //
  // A passive effect runs after the browser painted, so switching notes
  // would show the previous note's text for one frame. A layout effect runs
  // before the paint (and before any input can be processed), so the new
  // note's text is what the user sees, and a keystroke can never land in
  // the gap between the two notes.
  useLayoutEffect(() => {
    // The flush below must consult the PREVIOUS view (trash or not), so the
    // ref is captured before it is updated.
    const previousWasTrash = wasTrashViewRef.current;
    wasTrashViewRef.current = isTrashView;

    if (note) {
      if (currentFileNameRef.current !== note.fileName) {
        const previousFileName = currentFileNameRef.current;
        const previousContent = contentRef.current;
        const hadPendingSave = saveTimeoutRef.current !== null;
        // Cancel the previous note's debounce, then flush it immediately.
        // Its closure holds the previous note's text, so clearing it
        // alone drops the last <500ms of typing when the user clicks
        // another note.
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
          saveTimeoutRef.current = null;
        }
        saveVersionRef.current += 1;
        if (hadPendingSave && previousFileName && !previousWasTrash) {
          if (dirtyFileRef.current === previousFileName) dirtyFileRef.current = null;
          void onSaveContent(previousFileName, previousContent);
        }
        currentFileNameRef.current = note.fileName;
        setContent(note.content);
        // The note on disk is the baseline — a blur without an edit must
        // not rewrite the file (and the whole backup).
        lastSavedRef.current = { fileName: note.fileName, content: note.content };
        historyRef.current.reset(note.content, 0);
        setSaveStatus('saved');
        setSaveError('');
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      } else if (note.content !== contentRef.current && dirtyFileRef.current !== note.fileName) {
        // External content change (refresh, restore, backup merge) for the
        // SAME note: adopt it so the editor never shows a stale copy — but
        // never over text that is not on disk yet, which would revert the
        // last keystrokes (and then save the reverted text).
        // The user's caret (clamped) and history are preserved.
        setContent(note.content);
        // The adopted text IS the saved text — otherwise the next blur
        // rewrites the note (and the whole backup) for no reason.
        lastSavedRef.current = { fileName: note.fileName, content: note.content };
        historyRef.current.record(note.content, Math.min(contentRef.current.length, note.content.length));
      }
    } else {
      // The note went away (deleted, or the scope became empty): flush the
      // pending text before clearing it.
      const previousFileName = currentFileNameRef.current;
      const previousContent = contentRef.current;
      const hadPendingSave = saveTimeoutRef.current !== null;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      saveVersionRef.current += 1;
      if (hadPendingSave && previousFileName && !previousWasTrash) {
        if (dirtyFileRef.current === previousFileName) dirtyFileRef.current = null;
        void onSaveContent(previousFileName, previousContent);
      }
      currentFileNameRef.current = null;
      lastSavedRef.current = null;
      setContent('');
      historyRef.current.reset('', 0);
      setSaveStatus('saved');
    }
    // note.content is in the deps on purpose: an external write to the same
    // note (refresh / restore / backup merge) must reach the textarea. The
    // equality guard above makes our own optimistic autosave a no-op.
  }, [note?.fileName, note?.content, isTrashView, onSaveContent]);

  const flushSave = useCallback(async (force = false) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (currentFileNameRef.current && !isTrashView) {
      const fileName = currentFileNameRef.current;
      const text = contentRef.current;
      // nothing changed since the last successful write → no disk
      // write (and no full All Notes.txt rewrite). Ctrl+S forces it.
      const last = lastSavedRef.current;
      if (!force && last && last.fileName === fileName && last.content === text) {
        setSaveStatus('saved');
        setSaveError('');
        return;
      }
      const version = ++saveVersionRef.current;
      setSaveStatus('saving');
      const result = await onSaveContent(fileName, text);
      // Only report if this is still the latest save for this note —
      // a slow save must not clobber the status of a newer one.
      if (saveVersionRef.current === version) {
        setSaveStatus(result.ok ? 'saved' : 'failed');
        setSaveError(result.ok ? '' : result.error || 'Disk write failed.');
      }
      // The saved baseline belongs to the note that is open NOW. A slow
      // save for the previous note finishing after a switch must not
      // overwrite the new note's baseline — that would make the next
      // blur rewrite the new note (and its whole backup) for no reason.
      if (result.ok && currentFileNameRef.current === fileName) {
        lastSavedRef.current = { fileName, content: text };
        if (contentRef.current === text && dirtyFileRef.current === fileName) {
          dirtyFileRef.current = null;
        }
      }
    }
  }, [onSaveContent, isTrashView]);

  // App-level controls: the window close handler awaits flush(), and the
  // window-level Ctrl+E calls togglePreview(). Both live here because the
  // save timer and the textarea do.
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      flush: () => flushSave(),
      togglePreview: () =>
        setViewMode((prev) => (prev === 'preview' ? 'edit' : 'preview')),
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, flushSave]);

  // Unmount (window closing): never drop a pending autosave. The
  // close-requested handler in App awaits flush() first, so this is the
  // backstop for any other unmount path.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      const saved = lastSavedRef.current;
      if (
        currentFileNameRef.current &&
        !wasTrashViewRef.current &&
        !(saved && saved.fileName === currentFileNameRef.current && saved.content === contentRef.current)
      ) {
        void onSaveContentRef.current(currentFileNameRef.current, contentRef.current);
      }
    };
  }, []);

  // Menus belong to the note that opened them — a keyboard switch or a
  // deletion underneath must not leave them pointing at the old note.
  useEffect(() => {
    setShowFolderDropdown(false);
    setShowMoreMenu(false);
    closeEditorMenu();
  }, [note?.fileName, closeEditorMenu]);

  // Returning to edit/split (toolbar button or Ctrl+E) puts the caret back
  // in the textarea so typing continues without a click.
  useEffect(() => {
    if (viewMode !== 'preview') {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [viewMode]);

  const scheduleSave = useCallback(
    (newContent: string) => {
      if (isTrashView) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      const fileName = currentFileNameRef.current;
      if (!fileName) return;
      // this file now holds text that is not on disk yet.
      dirtyFileRef.current = fileName;
      setSaveStatus('saving');
      const version = ++saveVersionRef.current;
      saveTimeoutRef.current = setTimeout(async () => {
        // The timer has fired — clear the ref now. A stale non-null ref
        // would make every later note switch treat the note as unsaved and
        // rewrite it (file + All Notes.txt) with a bumped modifiedAt.
        saveTimeoutRef.current = null;
        if (currentFileNameRef.current !== fileName) return;
        const result = await onSaveContent(fileName, newContent);
        if (saveVersionRef.current === version) {
          setSaveStatus(result.ok ? 'saved' : 'failed');
          setSaveError(result.ok ? '' : result.error || 'Disk write failed.');
        }
        // Same rule as in flushSave: a save that finishes after the user
        // switched notes must not overwrite the new note's baseline.
        if (result.ok && currentFileNameRef.current === fileName) {
          lastSavedRef.current = { fileName, content: newContent };
          if (contentRef.current === newContent && dirtyFileRef.current === fileName) {
            dirtyFileRef.current = null;
          }
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [onSaveContent, isTrashView]
  );

  const handleDelete = async () => {
    if (!note) return;
    // Save the final keystrokes before asking for confirmation. Nothing is
    // marked until the user actually confirms, so cancelling the dialog
    // leaves autosave enabled.
    await flushSave();
    onDeleteNote(note.fileName);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart;
    setContent(val);
    historyRef.current.record(val, cursor);
    scheduleSave(val);
  };

  const applyEdit = useCallback(
    (newValue: string, newCursor: number) => {
      setContent(newValue);
      historyRef.current.record(newValue, newCursor, true);
      scheduleSave(newValue);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = newCursor;
          textareaRef.current.selectionEnd = newCursor;
          // Cut/Paste came from the context menu — focus was on the
          // menu button, which unmounts when the menu closes. Without
          // this, typing after a Cut/Paste goes nowhere.
          textareaRef.current.focus();
        }
      });
    },
    [scheduleSave]
  );

  /** Undo/redo: apply the snapshot and restore the caret. */
  const undo = useCallback(() => {
    if (isTrashView) return;
    const prev = historyRef.current.undo();
    if (!prev) return;
    setContent(prev.content);
    scheduleSave(prev.content);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = prev.cursor;
        textareaRef.current.selectionEnd = prev.cursor;
      }
    });
  }, [isTrashView, scheduleSave]);

  const redo = useCallback(() => {
    if (isTrashView) return;
    const next = historyRef.current.redo();
    if (!next) return;
    setContent(next.content);
    scheduleSave(next.content);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = next.cursor;
        textareaRef.current.selectionEnd = next.cursor;
      }
    });
  }, [isTrashView, scheduleSave]);

  useEffect(() => {
    if (!editorMenu.isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = document.getElementById('editor-context-menu');
      if (el && !el.contains(e.target as Node)) closeEditorMenu();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditorMenu();
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editorMenu.isOpen, closeEditorMenu]);

  const handleEditorContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setEditorMenu({ isOpen: true, x: e.clientX, y: e.clientY });
  };

  const getSelection = () => {
    const ta = textareaRef.current;
    if (!ta) return { start: 0, end: 0, selected: '' };
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    return { start, end, selected: contentRef.current.slice(start, end) };
  };

  const handleMenuCopy = async () => {
    const { selected } = getSelection();
    const text = selected || contentRef.current;
    if (!text) return;
    await safeClipboardCopy(text);
    closeEditorMenu();
  };

  const handleMenuCut = async () => {
    if (isTrashView) return;
    const { start, end, selected } = getSelection();
    if (!selected) return;
    await safeClipboardCopy(selected);
    applyEdit(contentRef.current.slice(0, start) + contentRef.current.slice(end), start);
    closeEditorMenu();
  };

  const handleMenuPaste = async () => {
    if (isTrashView) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      closeEditorMenu();
      return;
    }
    if (!text) {
      closeEditorMenu();
      return;
    }
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? contentRef.current.length;
    const end = ta?.selectionEnd ?? contentRef.current.length;
    applyEdit(contentRef.current.slice(0, start) + text + contentRef.current.slice(end), start + text.length);
    closeEditorMenu();
  };

  const handleMenuSelectAll = () => {
    textareaRef.current?.select();
    closeEditorMenu();
  };

  // formatting toolbar (Modrinth-style Markdown: bold, italic,
  // strikethrough, headings, lists, quote, code, link, image, divider).
  // Same edit pipeline as applyEdit (set content + record history +
  // autosave), but restores a selection RANGE so the user can type over a
  // placeholder (e.g. the "bold text" inside **…**).
  const applyEditRange = useCallback(
    (newValue: string, selStart: number, selEnd: number) => {
      setContent(newValue);
      historyRef.current.record(newValue, selStart, true);
      scheduleSave(newValue);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = selStart;
          textareaRef.current.selectionEnd = selEnd;
          textareaRef.current.focus();
        }
      });
    },
    [scheduleSave]
  );

  type FormatKind =
    | 'bold' | 'italic' | 'strike' | 'code'
    | 'link' | 'image'
    | 'h1' | 'h2' | 'h3'
    | 'bullet' | 'numbered' | 'task' | 'quote'
    | 'codeblock' | 'hr';

  const applyFormat = useCallback(
    (kind: FormatKind) => {
      if (isTrashView) return;
      const ta = textareaRef.current;
      const content = contentRef.current;
      const start = ta?.selectionStart ?? content.length;
      let end = ta?.selectionEnd ?? content.length;
      // A selection ending exactly on a newline (double-clicking the last
      // word of a line, Shift+Down) does not include the next line — the
      // same rule getSelectedLineBounds already applies to line formats.
      // Trim it here so an inline format never drags the next row in.
      // Trailing spaces/tabs go first: double-clicking a mid-line word
      // grabs the following space, and `**There **` never renders as
      // bold — a closing delimiter preceded by whitespace is not a
      // delimiter at all. The trimmed characters stay in `after`, so
      // nothing is lost; only the marker placement changes.
      while (end > start && (content[end - 1] === ' ' || content[end - 1] === '\t')) end -= 1;
      if (end > start && content[end - 1] === '\n') end -= 1;
      const selected = content.slice(start, end);
      const before = content.slice(0, start);
      const after = content.slice(end);

      // Inline wrap (bold/italic/strike/code): toggle — unwrap when the
      // selection is already wrapped, otherwise wrap it. Empty selection
      // inserts a placeholder with the inner text selected.
      const wrapInline = (marker: string, placeholder: string) => {
        // The selection is already wrapped only when the marker run before
        // it OPENS a span and the run after it CLOSES one. An opener must
        // not be the closer of a previous span, so the character before it
        // must not be a word character (`**old**Hello**` must not unwrap
        // to `**oldHello`). A closer may sit on the next line — markers
        // typed on their own row, `**text\n**` — but only when nothing
        // word-like follows it, or it opens a new span on that row
        // (`**Hello\n**World**` must not eat World's opener). A single `*`
        // must not match the `**` of a bold wrap, on either side.
        const isWordChar = (ch: string | undefined) =>
          ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
        // How many `*` touch the selection on each side. A single `*`
        // must not eat a bold `**` — but a run of 3 (`***`, bold+italic)
        // DOES carry an italic marker on its outer edge, so only a run of
        // exactly 2 blocks the italic unwrap. Counting the run (instead of
        // just testing "ends with **") is what makes bold+italic toggle off
        // cleanly instead of growing a star on every press. The closer may
        // sit on the next line or after spaces, so count it where the
        // closer actually starts.
        const starRunAtEnd = (s: string) => {
          let n = 0;
          for (let i = s.length - 1; i >= 0 && s[i] === '*'; i--) n++;
          return n;
        };
        const starRunAtStart = (s: string) => {
          let n = 0;
          for (let i = 0; i < s.length && s[i] === '*'; i++) n++;
          return n;
        };
        const openRun = marker === '*' ? starRunAtEnd(before) : 0;
        let closeRun = 0;
        if (marker === '*') {
          if (after.startsWith('*')) closeRun = starRunAtStart(after);
          else if (after.startsWith('\n')) closeRun = starRunAtStart(after.slice(1));
          else {
            const sp = after.match(/^[ \t]+/);
            if (sp) closeRun = starRunAtStart(after.slice(sp[0].length));
          }
        }
        // The selection itself may already carry the markers — the user
        // dragged across `**There**`, markers included. Unwrap the
        // selection itself instead of wrapping it a second time:
        // `**There**` + Bold must become `There`, never `****There****`.
        // Same rule as the outer check: a `*` run of exactly 2 is a
        // bold wrap, not italic (`**There**` + Italic adds italic to
        // make `***There***`); a run of 3 is bold+italic, so its outer
        // `*` IS the italic marker and unwraps to `**There**`.
        if (selected.length > 0) {
          let selfInner: string | null = null;
          if (marker === '**' || marker === '~~') {
            if (
              selected.length > marker.length * 2 &&
              selected.startsWith(marker) &&
              selected.endsWith(marker)
            ) {
              selfInner = selected.slice(marker.length, -marker.length);
            }
          } else if (marker === '*') {
            const run = starRunAtStart(selected);
            if (
              selected.length > 2 &&
              selected.startsWith('*') &&
              selected.endsWith('*') &&
              run !== 2
            ) {
              selfInner = selected.slice(1, -1);
            }
          } else if (marker === '`') {
            if (selected.length > 2 && selected.startsWith('`') && selected.endsWith('`')) {
              selfInner = selected.slice(1, -1);
            }
          }
          if (selfInner !== null) {
            const newValue = before + selfInner + after;
            applyEditRange(newValue, start, start + selfInner.length);
            return;
          }
        }
        const beforeRun = before.slice(0, before.length - marker.length);
        const openerOk =
          before.endsWith(marker) &&
          !isWordChar(beforeRun[beforeRun.length - 1]) &&
          !(marker === '*' && (openRun === 2 || closeRun === 2));
        let closerLen = 0;
        // Chars of the closer to KEEP in the unwrapped text: the spaces
        // between the selection and the closing marker are word separators
        // ("**There **" unwraps to "There ", not "There"), and a newline
        // before a closing marker on its own row is a line break, not
        // part of the marker ("**Hello\n** World" unwraps to
        // "Hello\n World" — without the kept newline the two lines
        // would merge into one).
        let closerKeep = '';
        if (after.startsWith(marker)) {
          closerLen = marker.length;
        } else if (after.startsWith('\n' + marker)) {
          const rest = after.slice(marker.length + 1);
          if (rest === '' || !isWordChar(rest[0])) {
            closerLen = marker.length + 1;
            closerKeep = '\n';
          }
        } else {
          // Spaces/tabs between the selection and the closing marker, e.g.
          // "**There **" with just "There" selected: the closer is " **".
          // A single `*` must not eat a bold `**` run — but a run of 3
          // (`***`) carries an italic marker on its outer edge, so only a
          // run of exactly 2 blocks the italic unwrap (same rule as above).
          const spaces = after.match(/^[ \t]+/);
          if (spaces) {
            const rest = after.slice(spaces[0].length);
            if (rest.startsWith(marker) && !(marker === '*' && starRunAtStart(rest) === 2)) {
              closerLen = spaces[0].length + marker.length;
              closerKeep = spaces[0];
            }
          }
        }
        const wrapped = openerOk && closerLen > 0;
        if (wrapped) {
          const newValue = beforeRun + selected + closerKeep + after.slice(closerLen);
          applyEditRange(newValue, start - marker.length, end - marker.length);
          return;
        }
        // Not wrapped: trailing whitespace stays OUTSIDE the markers. The
        // trim above removes spaces/tabs first and then one newline, so a
        // selection ending "space then newline" ("There \n") still carries
        // the space — and a closing delimiter preceded by whitespace is
        // not a delimiter at all, so "**There **" never renders as bold.
        // Move every trailing space/tab/newline past the closing marker.
        // This runs only after the wrap check above, so a wrapped span
        // whose closer sits on the next row still unwraps instead.
        let sel = selected;
        let aft = after;
        while (
          sel.length > 0 &&
          (sel.endsWith(' ') || sel.endsWith('\t') || sel.endsWith('\n'))
        ) {
          aft = sel.slice(-1) + aft;
          sel = sel.slice(0, -1);
        }
        if (sel) {
          const newValue = before + marker + sel + marker + aft;
          applyEditRange(newValue, start + marker.length, start + marker.length + sel.length);
        } else {
          const newValue = before + marker + placeholder + marker + aft;
          applyEditRange(
            newValue,
            start + marker.length,
            start + marker.length + placeholder.length
          );
        }
      };

      // Line prefix (headings/lists/quote): apply to every line the
      // selection touches (or the caret line). Toggle — remove when every
      // line already has the prefix.
      const prefixLines = (prefix: string | ((i: number) => string), strip: RegExp) => {
        const { lineStart, lineEnd } = getSelectedLineBounds(content, start, end);
        const block = content.slice(lineStart, lineEnd);
        const lines = block.split('\n');
        const allHave = lines.every((l) => strip.test(l));
        const nextLines = allHave
          ? lines.map((l) => l.replace(strip, ''))
          : lines.map((l, i) => {
              // A line that already carries the marker keeps it — a
              // numbered line is re-numbered so the sequence stays 1, 2,
              // 3… Prefixing blindly would turn a partial block ("- a", "b")
              // into "- - a".
              if (typeof prefix === 'function') return prefix(i) + l.replace(strip, '');
              return strip.test(l) ? l : prefix + l;
            });
        const newBlock = nextLines.join('\n');
        const newValue = content.slice(0, lineStart) + newBlock + content.slice(lineEnd);
        // With a collapsed cursor (starting a list/heading on an empty
        // line), the caret goes AFTER the new prefix — selecting the whole
        // block would let the next keystroke delete the prefix. A real
        // multi-line selection stays selected.
        if (start === end) {
          applyEditRange(newValue, lineStart + newBlock.length, lineStart + newBlock.length);
        } else {
          applyEditRange(newValue, lineStart, lineStart + newBlock.length);
        }
      };

      switch (kind) {
        case 'bold':
          wrapInline('**', 'bold text');
          return;
        case 'italic':
          wrapInline('*', 'italic text');
          return;
        case 'strike':
          wrapInline('~~', 'strikethrough');
          return;
        case 'code':
          wrapInline('`', 'code');
          return;
        case 'link': {
          if (selected) {
            const newValue = before + '[' + selected + '](url)' + after;
            applyEditRange(newValue, start + selected.length + 3, start + selected.length + 6);
          } else {
            const newValue = before + '[text](url)' + after;
            applyEditRange(newValue, start + 1, start + 5);
          }
          return;
        }
        case 'image': {
          if (selected) {
            const newValue = before + '![' + selected + '](url)' + after;
            applyEditRange(newValue, start + selected.length + 4, start + selected.length + 7);
          } else {
            const newValue = before + '![alt](url)' + after;
            applyEditRange(newValue, start + 2, start + 5);
          }
          return;
        }
        case 'h1':
        case 'h2':
        case 'h3': {
          const level = kind === 'h1' ? 1 : kind === 'h2' ? 2 : 3;
          const target = '#'.repeat(level) + ' ';
          const { lineStart, lineEnd } = getSelectedLineBounds(content, start, end);
          const block = content.slice(lineStart, lineEnd);
          const lines = block.split('\n');
          const headingRe = /^#{1,6}\s+/;
          const nextLines = lines.map((l) => {
            if (l.startsWith(target)) return l.slice(target.length);
            if (headingRe.test(l)) return l.replace(headingRe, target);
            return target + l;
          });
          const newBlock = nextLines.join('\n');
          const newValue = content.slice(0, lineStart) + newBlock + content.slice(lineEnd);
          if (start === end) {
            applyEditRange(newValue, lineStart + newBlock.length, lineStart + newBlock.length);
          } else {
            applyEditRange(newValue, lineStart, lineStart + newBlock.length);
          }
          return;
        }
        case 'bullet':
          prefixLines('- ', /^- /);
          return;
        case 'numbered':
          prefixLines((i) => `${i + 1}. `, /^\d+\. /);
          return;
        case 'task': {
          // One button runs the whole task lifecycle, per line:
          // plain -> unchecked task -> checked task -> plain. A
          // bullet or numbered line becomes an unchecked task (its
          // own marker is replaced, never doubled). Indent is kept.
          const { lineStart, lineEnd } = getSelectedLineBounds(content, start, end);
          const block = content.slice(lineStart, lineEnd);
          const lines = block.split('\n');
          const nextLines = lines.map((l) => {
            // Checked task -> plain (drop the whole `- [x] ` prefix).
            if (/^\s*[-*+]\s*\[[xX]\]\s?/.test(l)) {
              return l.replace(/^(\s*)[-*+]\s*\[[xX]\]\s?/, '$1');
            }
            // Unchecked task -> checked.
            if (/^\s*[-*+]\s*\[ \]\s?/.test(l)) {
              return l.replace(/^(\s*[-*+]\s*\[) (\])/, '$1x$2');
            }
            // Bullet -> unchecked task.
            if (/^\s*[-*+]\s+/.test(l)) {
              return l.replace(/^(\s*)[-*+]\s+/, '$1- [ ] ');
            }
            // Numbered -> unchecked task.
            if (/^\s*\d+\.\s+/.test(l)) {
              return l.replace(/^(\s*)\d+\.\s+/, '$1- [ ] ');
            }
            // Plain -> unchecked task (after any indent).
            return l.replace(/^(\s*)/, '$1- [ ] ');
          });
          const newBlock = nextLines.join('\n');
          const newValue = content.slice(0, lineStart) + newBlock + content.slice(lineEnd);
          if (start === end) {
            applyEditRange(newValue, lineStart + newBlock.length, lineStart + newBlock.length);
          } else {
            applyEditRange(newValue, lineStart, lineStart + newBlock.length);
          }
          return;
        }
        case 'quote':
          prefixLines('> ', /^> /);
          return;
        case 'codeblock': {
          const fenced = before.endsWith('```\n') && after.startsWith('\n```');
          if (fenced) {
            const newValue =
              before.slice(0, before.length - 4) + selected + after.slice(4);
            applyEditRange(newValue, start - 4, end - 4);
            return;
          }
          if (selected) {
            const newValue = before + '```\n' + selected + '\n```' + after;
            applyEditRange(newValue, start + 4, end + 4);
          } else {
            const newValue = before + '```\n\n```' + after;
            applyEditRange(newValue, start + 4, start + 4);
          }
          return;
        }
        case 'hr': {
          const sep = (before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n');
          const tail = after.startsWith('\n') ? '' : '\n';
          const insert = sep + '---' + tail;
          const newValue = before + insert + after;
          applyEditRange(newValue, start + insert.length, start + insert.length);
          return;
        }
      }
    },
    [isTrashView, applyEditRange]
  );

  // Flip the Nth task item in the note (`- [ ]` <-> `- [x]`), N in
  // document order — the index the sanitizer stamps on each preview
  // checkbox as `data-task`. Content + history + autosave update,
  // but focus stays where it was: the user clicked in the preview,
  // so stealing focus to the textarea would be jarring (and in
  // preview-only mode there is no visible textarea at all).
  const toggleTaskAtIndex = useCallback(
    (index: number) => {
      if (isTrashView) return;
      const content = contentRef.current;
      const lines = content.split('\n');
      // The index counts the checkboxes marked actually renders, so this
      // scan must mirror the renderer: skip fenced code blocks (their
      // task-looking lines render as literal code, no checkbox) and count
      // ordered-list and blockquote tasks too (marked renders those).
      const TASK_RE = /^((?:\s*>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/;
      let seen = -1;
      let fence: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const fenceMatch = line.match(/^\s*(```+|~~~+)/);
        if (fenceMatch) {
          const marker = fenceMatch[1]![0]!;
          if (fence === null) fence = marker;
          else if (fence === marker) fence = null;
          continue;
        }
        if (fence !== null) continue;
        const m = line.match(TASK_RE);
        if (!m) continue;
        seen++;
        if (seen !== index) continue;
        const checked = m[2] !== ' ';
        lines[i] = line.replace(
          TASK_RE,
          (_full, p1: string, _state: string, p3: string) => `${p1}${checked ? ' ' : 'x'}${p3}`
        );
        const newValue = lines.join('\n');
        const caret = textareaRef.current?.selectionStart ?? 0;
        setContent(newValue);
        historyRef.current.record(newValue, caret, true);
        scheduleSave(newValue);
        return;
      }
    },
    [isTrashView, scheduleSave]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;

    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      applyFormat('bold');
      return;
    }

    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      applyFormat('italic');
      return;
    }

    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      applyFormat('link');
      return;
    }

    // Ctrl/Cmd+S — force an immediate save (autosave already runs, but a
    // manual "save now" is expected muscle memory).
    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void flushSave(true);
      return;
    }

    if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }

    if ((isCtrlOrCmd && e.key.toLowerCase() === 'y') || (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault();
      redo();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (isTrashView) return;
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const current = contentRef.current;
      // A selection ending exactly on a newline does not include the next
      // line, so the touched block is computed precisely.
      const { lineStart, lineEnd } = getSelectedLineBounds(current, start, end);
      const lines = current.slice(lineStart, lineEnd).split('\n');

      const removedForLine = (line: string): number => {
        const m = line.match(/^( {1,2}|\t)/);
        return m && m[1] ? m[1].length : 0;
      };

      let nextLines: string[];
      let newStart: number;
      let newEnd: number;

      if (e.shiftKey) {
        // Shift+Tab: outdent every touched line. Each line loses at most
        // one tab or two spaces.
        let totalRemoved = 0;
        const removedPerLine: number[] = [];
        nextLines = lines.map((line) => {
          const removed = removedForLine(line);
          removedPerLine.push(removed);
          totalRemoved += removed;
          return removed > 0 ? line.slice(removed) : line;
        });
        const firstRemoved = removedPerLine[0] ?? 0;
        const caretInFirstLine = Math.max(0, start - lineStart);
        const removedBeforeStart = Math.min(firstRemoved, caretInFirstLine);
        const lastLine = lines[lines.length - 1] ?? '';
        const lastRemoved = removedPerLine[removedPerLine.length - 1] ?? 0;
        const lastLineStart = lineEnd - lastLine.length;
        const endOffsetInLast = Math.max(0, end - lastLineStart);
        const removedBeforeEnd =
          totalRemoved - lastRemoved + Math.min(lastRemoved, endOffsetInLast);
        newStart = start - removedBeforeStart;
        newEnd = Math.max(newStart, end - removedBeforeEnd);
      } else {
        // Tab: indent every touched line by two spaces.
        nextLines = lines.map((line) => '  ' + line);
        newStart = start + 2;
        newEnd = end + 2 * lines.length;
      }

      const newBlock = nextLines.join('\n');
      const newText = current.slice(0, lineStart) + newBlock + current.slice(lineEnd);
      setContent(newText);
      historyRef.current.record(newText, newStart, true);
      scheduleSave(newText);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = newStart;
          textareaRef.current.selectionEnd = newEnd;
        }
      });
    }
  };

  // Keep the line-number gutter scrolled in sync with the textarea.
  const handleTextareaScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // The portal menu lives outside folderDropdownRef, so check both.
      if (
        folderDropdownRef.current && !folderDropdownRef.current.contains(target) &&
        !(folderPortalRef.current && folderPortalRef.current.contains(target))
      ) {
        setShowFolderDropdown(false);
      }
    };
    // Escape closes the dropdown as well as an outside click.
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowFolderDropdown(false);
    };
    if (showFolderDropdown) {
      window.addEventListener('mousedown', handleOutside);
      window.addEventListener('keydown', handleEsc);
    }
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [showFolderDropdown]);

  // Measure the folder button and clamp the portal menu inside the viewport.
  useLayoutEffect(() => {
    if (!showFolderDropdown || !folderButtonRef.current) {
      setFolderMenuPos(null);
      return;
    }
    const measure = () => {
      const btn = folderButtonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuW = 192; // w-48
      const menuH = 220; // header + "No folder" + folder rows, clamped
      const x = Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8));
      const y = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menuH - 8));
      setFolderMenuPos({ x, y });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [showFolderDropdown]);

  // "More" overflow menu: outside-click + Escape + viewport-clamped position.
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        moreButtonRef.current && !moreButtonRef.current.contains(target) &&
        !(morePortalRef.current && morePortalRef.current.contains(target))
      ) {
        setShowMoreMenu(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMoreMenu(false);
    };
    if (showMoreMenu) {
      window.addEventListener('mousedown', handleOutside);
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showMoreMenu]);

  useLayoutEffect(() => {
    if (!showMoreMenu || !moreButtonRef.current) {
      setMoreMenuPos(null);
      return;
    }
    const measure = () => {
      const btn = moreButtonRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const menuW = 208; // w-52
      const menuH = 264; // six actions + divider, clamped
      const x = Math.max(8, Math.min(rect.right - menuW, window.innerWidth - menuW - 8));
      const y = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menuH - 8));
      setMoreMenuPos({ x, y });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [showMoreMenu]);

  const handleCopyMarkdown = async () => {
    if (!contentRef.current) return;
    const ok = await safeClipboardCopy(contentRef.current);
    if (ok) {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!note) return;
    const blob = new Blob([contentRef.current], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = note.fileName;
    a.click();
    // revoking immediately races WebView2 starting the download, so
    // the revoke waits a second.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const stats = useMemo(() => calculateTextStats(content), [content]);
  const tags = useMemo(() => extractNoteTags(content), [content]);
  // The gutter is capped: a pathological single-line note would otherwise
  // render 100k rows. The status bar still shows the real count.
  // One split per keystroke, not two.
  const totalLines = useMemo(() => Math.max(1, content.split('\n').length), [content]);
  const lineCount = Math.min(5000, totalLines);
  const editorFontSize = settings.editorFontSize;
  // Editor font family. System = the app font (Segoe UI stack); Serif =
  // Georgia, easier on the eyes for long reading; Mono = Cascadia Mono.
  // The textarea and gutter pin fontWeight 400, so the "Bold interface
  // text" setting can never bold what the user writes.
  const editorFontFamily =
    settings.editorFontFamily === 'serif'
      ? "Georgia, 'Times New Roman', serif"
      : settings.editorFontFamily === 'mono'
        ? 'var(--font-mono)'
        : 'var(--font-sans)';
  const editorFontLabel =
    settings.editorFontFamily === 'serif'
      ? 'Serif'
      : settings.editorFontFamily === 'mono'
        ? 'Mono'
        : 'System';
  const readingMinutes = stats.readingTimeMinutes;
  // The preview is only parsed while it is visible. In edit mode the
  // preview pane is not rendered at all, so parsing on every keystroke
  // would burn the whole marked + sanitize pass for nothing (measured:
  // ~18ms per keystroke on a 50KB note, ~74ms on a 200KB note, before
  // the sanitize walk on top). The last rendered HTML is kept in a ref
  // and returned as-is while editing; switching to preview or split
  // re-runs this memo (viewMode is a dep) and parses the current text.
  // Large notes (>300 KB) skip the preview re-parse per keystroke: the
  // preview shows the last rendered version instead of janking the UI.
  const lastRenderedHtmlRef = useRef('');
  const renderedHtml = useMemo(() => {
    if (viewMode === 'edit') return lastRenderedHtmlRef.current;
    if (content.length > 300 * 1024) {
      return '<p><em>Preview paused for very large notes — switch to Edit (Ctrl+E) to keep editing.</em></p>';
    }
    const html = sanitizeMarkdownHtml(
      marked.parse(content || '*No content yet*', { async: false }) as string
    );
    lastRenderedHtmlRef.current = html;
    return html;
  }, [content, viewMode]);

  if (!note) {
    return (
      <main className="flex-1 h-full flex flex-col items-center justify-center p-8 text-center select-none animate-fade-in">
        <div className="w-16 h-16 rounded-3xl glass flex items-center justify-center theme-accent mb-4 animate-float">
          <Sparkles className="w-8 h-8 opacity-90" />
        </div>
        <h2 className="text-base font-bold tracking-tight theme-text">No Note Selected</h2>
        <p className="text-xs theme-muted max-w-sm mt-1.5 leading-relaxed">
          Select a note from the left sidebar or click below to start writing. Your first line becomes the note. Everything is autosaved.
        </p>
        <button
          onClick={onNewNote}
          className="mt-5 px-5 py-2.5 rounded-2xl btn-accent font-semibold text-xs transition-all duration-150 hover:scale-105 active:scale-95 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Edit3 className="w-4 h-4" />
          <span>Write a note</span>
        </button>
      </main>
    );
  }

  const viewModeOptions: { id: ViewMode; label: string; title: string; icon: React.ReactNode; hidden?: boolean }[] = [
    { id: 'edit', label: 'Edit', title: 'Edit mode', icon: <Edit3 className="w-3.5 h-3.5" /> },
    { id: 'split', label: 'Split', title: 'Split view (Edit + Preview)', icon: <Columns className="w-3.5 h-3.5" />, hidden: true },
    { id: 'preview', label: 'Preview', title: 'Markdown preview (Ctrl+E)', icon: <Eye className="w-3.5 h-3.5" /> },
  ];

  const iconBtnClass =
    'p-1.5 rounded-xl theme-muted hover:text-[var(--text)] hover:bg-[var(--raised)] transition-all duration-150 hover:scale-[1.06] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100';

  return (
    <main className="flex-1 h-full flex flex-col min-w-0 overflow-hidden">
      <div key={note.fileName} className="flex-1 flex flex-col min-h-0 animate-fade-in">
        {isTrashView && (
          <div
            className="shrink-0 mx-3 mt-2.5 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 rounded-2xl text-xs animate-slide-in"
            style={{
              background: 'var(--glass-strong)',
              border: '1px solid color-mix(in srgb, var(--danger) 30%, var(--glass-border))',
              boxShadow: 'inset 0 1px 0 var(--glass-highlight)',
              color: 'var(--text)',
            }}
          >
            <span className="flex items-center gap-2 theme-danger font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              This note is in Trash — it is read-only here.
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {onRestoreNote && (
                <button
                  onClick={() => onRestoreNote(note.fileName)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg btn-accent font-semibold transition-all duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <RotateCcw className="w-3 h-3" />
                  Restore
                </button>
              )}
              {onDeleteForever && (
                <button
                  onClick={() => onDeleteForever(note.fileName)}
                  className="px-3 py-1.5 rounded-lg border font-semibold theme-danger transition-all duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]/60"
                  style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, transparent)' }}
                >
                  Delete forever
                </button>
              )}
              {onEmptyTrash && (
                <button
                  onClick={onEmptyTrash}
                  className="px-3 py-1.5 rounded-lg btn-ghost theme-muted font-semibold transition-all duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  Empty Trash
                </button>
              )}
            </span>
          </div>
        )}

        <div className="h-12 mx-3 mt-2.5 px-3 flex items-center justify-between gap-4 select-none glass-panel !rounded-2xl shrink-0">
          <div className="flex items-center gap-2 relative min-w-0" ref={folderDropdownRef}>
            <button
              ref={folderButtonRef}
              onClick={() => !isTrashView && setShowFolderDropdown(!showFolderDropdown)}
              disabled={isTrashView}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium btn-ghost hover:scale-[1.03] active:scale-95 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
              title={isTrashView ? 'Trashed note — restore it to move it' : 'Move note to folder'}
            >
              <FolderInput className="w-3.5 h-3.5 theme-accent" />
              <span className="truncate max-w-[130px]">{note.folder ? note.folder : 'No folder'}</span>
            </button>

            <button
              onClick={() => !isTrashView && onPinToggle(note.fileName)}
              disabled={isTrashView}
              className={`p-1.5 rounded-xl transition-all duration-150 hover:scale-[1.06] active:scale-95 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 ${
                note.pinned
                  ? 'text-amber-500 bg-amber-400/15 border-amber-400/30'
                  : 'theme-muted border-transparent hover:bg-[var(--raised)]'
              }`}
              title={note.pinned ? 'Unpin note' : 'Pin note (Ctrl+P)'}
            >
              {note.pinned ? <Pin className="w-3.5 h-3.5 fill-amber-500/30" /> : <PinOff className="w-3.5 h-3.5 opacity-50" />}
            </button>
          </div>
          {showFolderDropdown && !isTrashView && createPortal(
            <div
              ref={folderPortalRef}
              style={{
                position: 'fixed',
                left: `${folderMenuPos?.x ?? 8}px`,
                top: `${folderMenuPos?.y ?? 8}px`,
                zIndex: 99999,
              }}
              className="w-48 glass-menu p-1.5 flex flex-col gap-0.5 animate-menu-in max-h-64 overflow-y-auto"
            >
              <div className="px-2.5 py-1 text-[10px] uppercase font-bold theme-faint tracking-wider">
                Move note to:
              </div>
              <button
                onClick={() => {
                  onMoveToFolder(note.fileName, '');
                  setShowFolderDropdown(false);
                }}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-left text-xs transition-all duration-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  !note.folder ? 'theme-accent font-semibold bg-[var(--raised)]' : 'hover:bg-[var(--raised)]'
                }`}
              >
                <span>No folder (Root)</span>
                {!note.folder && <Check className="w-3 h-3 ml-auto" />}
              </button>
              {folders.map((f) => (
                <button
                  key={f.name}
                  onClick={() => {
                    onMoveToFolder(note.fileName, f.name);
                    setShowFolderDropdown(false);
                  }}
                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-xl text-left text-xs truncate transition-all duration-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    note.folder === f.name ? 'theme-accent font-semibold bg-[var(--raised)]' : 'hover:bg-[var(--raised)]'
                  }`}
                >
                  <span className="truncate">{f.name}</span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {note.folder === f.name && <Check className="w-3 h-3" />}
                    <span className="text-[10px] theme-faint font-mono">{f.count}</span>
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )}

          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <div className="flex items-center p-1 rounded-xl glass shrink-0">
              {viewModeOptions.map((opt) => {
                const isActive = viewMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setViewMode(opt.id)}
                    title={opt.title}
                    aria-pressed={isActive}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-150 hover:scale-[1.04] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60 ${
                      isActive ? 'btn-accent' : 'theme-muted hover:text-[var(--text)] hover:bg-[var(--raised)]'
                    } ${opt.hidden ? 'hidden md:flex' : 'flex'}`}
                  >
                    {opt.icon}
                    <span className="hidden lg:inline">{opt.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-0.5 border-l pl-2 shrink-0" style={{ borderColor: 'var(--glass-border)' }}>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  textareaRef.current?.focus();
                }}
                onClick={undo}
                title="Undo (Ctrl+Z)"
                className={iconBtnClass}
                disabled={isTrashView}
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  textareaRef.current?.focus();
                }}
                onClick={redo}
                title="Redo (Ctrl+Y)"
                className={iconBtnClass}
                disabled={isTrashView}
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Overflow menu — the header carries only the essential
                actions, everything else lives in this portal menu. */}
            <div className="flex items-center gap-1 border-l pl-2 shrink-0" style={{ borderColor: 'var(--glass-border)' }}>
              <button
                ref={moreButtonRef}
                onClick={() => setShowMoreMenu(!showMoreMenu)}
                title="More actions"
                aria-expanded={showMoreMenu}
                className={iconBtnClass}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </div>
            {showMoreMenu && createPortal(
              <div
                ref={morePortalRef}
                style={{
                  position: 'fixed',
                  left: `${moreMenuPos?.x ?? 8}px`,
                  top: `${moreMenuPos?.y ?? 8}px`,
                  zIndex: 99999,
                }}
                className="w-52 glass-menu p-1.5 flex flex-col gap-0.5 animate-menu-in text-xs select-none"
              >
                {onToggleFocus && (
                  <button
                    onClick={() => { onToggleFocus(); setShowMoreMenu(false); }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98]"
                  >
                    {isFocusMode ? <Minimize className="w-4 h-4 theme-faint" /> : <Maximize className="w-4 h-4 theme-faint" />}
                    <span>{isFocusMode ? 'Exit focus mode' : 'Focus mode'}</span>
                    <span className="ml-auto text-[10px] theme-faint">Ctrl+Shift+F</span>
                  </button>
                )}
                {onDuplicateNote && !isTrashView && (
                  <button
                    onClick={() => { onDuplicateNote(note.fileName); setShowMoreMenu(false); }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98]"
                  >
                    <Files className="w-4 h-4 theme-faint" />
                    <span>Duplicate note</span>
                  </button>
                )}
                <button
                  onClick={() => { void handleCopyMarkdown(); setShowMoreMenu(false); }}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98]"
                >
                  {copyFeedback ? <Check className="w-4 h-4" style={{ color: 'var(--ok)' }} /> : <Copy className="w-4 h-4 theme-faint" />}
                  <span>{copyFeedback ? 'Copied!' : 'Copy markdown'}</span>
                </button>
                <button
                  onClick={() => { handleDownloadMarkdown(); setShowMoreMenu(false); }}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98]"
                >
                  <Download className="w-4 h-4 theme-faint" />
                  <span>Download .md file</span>
                </button>
                {onExportNote && !isTrashView && (
                  <button
                    onClick={() => { onExportNote(note.fileName); setShowMoreMenu(false); }}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98]"
                  >
                    <Upload className="w-4 h-4 theme-faint" />
                    <span>Export a copy to Exports</span>
                  </button>
                )}
                {!isTrashView && (
                  <>
                    <div className="my-1" style={{ borderTop: '1px solid var(--glass-border)' }} />
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setShowMoreMenu(false); handleDelete(); }}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-red-500/10 text-left transition-all duration-100 active:scale-[0.98] theme-danger"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>Move to Trash</span>
                    </button>
                  </>
                )}
              </div>,
              document.body
            )}
          </div>
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 mt-2.5 shrink-0 animate-fade-in">
            <span className="text-[10px] uppercase font-bold theme-faint tracking-wider">Tags</span>
            {tags.map((tag) => (
              <span key={tag} className="glass-chip theme-accent font-mono">
                #{tag}
              </span>
            ))}
          </div>
        )}

        {/* formatting toolbar (Modrinth-style Markdown). Only in
            edit/split mode, never in preview or Trash. Buttons use
            onMouseDown preventDefault so clicking one never steals focus
            from the textarea — the selection stays intact for applyFormat. */}
        {(viewMode === 'edit' || viewMode === 'split') && !isTrashView && (
          <div className="flex items-center gap-0.5 px-3 pt-2.5 shrink-0 select-none overflow-x-auto">
            {([
              { kind: 'bold' as FormatKind, icon: <Bold className="w-3.5 h-3.5" />, title: 'Bold (Ctrl+B)' },
              { kind: 'italic' as FormatKind, icon: <Italic className="w-3.5 h-3.5" />, title: 'Italic (Ctrl+I)' },
              { kind: 'strike' as FormatKind, icon: <Strikethrough className="w-3.5 h-3.5" />, title: 'Strikethrough' },
              { kind: 'code' as FormatKind, icon: <Code className="w-3.5 h-3.5" />, title: 'Inline code' },
            ]).map((b) => (
              <button
                key={b.kind}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat(b.kind)}
                title={b.title}
                className="p-1.5 rounded-lg theme-muted hover:bg-[var(--raised)] hover:text-[var(--text)] transition-all duration-100 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60"
              >
                {b.icon}
              </button>
            ))}
            <span className="w-px h-4 mx-1.5 shrink-0" style={{ background: 'var(--glass-border)' }} />
            {([
              { kind: 'h1' as FormatKind, icon: <Heading1 className="w-3.5 h-3.5" />, title: 'Heading 1' },
              { kind: 'h2' as FormatKind, icon: <Heading2 className="w-3.5 h-3.5" />, title: 'Heading 2' },
              { kind: 'h3' as FormatKind, icon: <Heading3 className="w-3.5 h-3.5" />, title: 'Heading 3' },
            ]).map((b) => (
              <button
                key={b.kind}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat(b.kind)}
                title={b.title}
                className="p-1.5 rounded-lg theme-muted hover:bg-[var(--raised)] hover:text-[var(--text)] transition-all duration-100 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60"
              >
                {b.icon}
              </button>
            ))}
            <span className="w-px h-4 mx-1.5 shrink-0" style={{ background: 'var(--glass-border)' }} />
            {([
              { kind: 'bullet' as FormatKind, icon: <List className="w-3.5 h-3.5" />, title: 'Bullet list' },
              { kind: 'numbered' as FormatKind, icon: <ListOrdered className="w-3.5 h-3.5" />, title: 'Numbered list' },
              { kind: 'task' as FormatKind, icon: <ListChecks className="w-3.5 h-3.5" />, title: 'Task list' },
              { kind: 'quote' as FormatKind, icon: <Quote className="w-3.5 h-3.5" />, title: 'Quote' },
              { kind: 'codeblock' as FormatKind, icon: <SquareCode className="w-3.5 h-3.5" />, title: 'Code block' },
            ]).map((b) => (
              <button
                key={b.kind}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat(b.kind)}
                title={b.title}
                className="p-1.5 rounded-lg theme-muted hover:bg-[var(--raised)] hover:text-[var(--text)] transition-all duration-100 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60"
              >
                {b.icon}
              </button>
            ))}
            <span className="w-px h-4 mx-1.5 shrink-0" style={{ background: 'var(--glass-border)' }} />
            {([
              { kind: 'link' as FormatKind, icon: <Link2 className="w-3.5 h-3.5" />, title: 'Link (Ctrl+K)' },
              { kind: 'image' as FormatKind, icon: <Image className="w-3.5 h-3.5" />, title: 'Image' },
              { kind: 'hr' as FormatKind, icon: <Minus className="w-3.5 h-3.5" />, title: 'Horizontal rule' },
            ]).map((b) => (
              <button
                key={b.kind}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyFormat(b.kind)}
                title={b.title}
                className="p-1.5 rounded-lg theme-muted hover:bg-[var(--raised)] hover:text-[var(--text)] transition-all duration-100 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60"
              >
                {b.icon}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 flex overflow-hidden p-3 gap-3 min-h-0">
          {(viewMode === 'edit' || viewMode === 'split') && (
            <div className={`h-full flex flex-col overflow-hidden glass-panel !rounded-2xl min-h-0 ${viewMode === 'split' ? 'w-1/2' : 'w-full'}`}>
              <div className="flex-1 flex min-h-0 overflow-hidden">
              {settings.lineNumbers && (
                <div
                  ref={gutterRef}
                  aria-hidden="true"
                  className="h-full overflow-hidden select-none py-8 pl-4 pr-3 text-right font-mono theme-faint tabular-nums shrink-0"
                  style={{
                    fontSize: `${editorFontSize}px`,
                    fontFamily: editorFontFamily,
                    fontWeight: 400,
                    lineHeight: 1.7,
                    borderRight: '1px solid var(--glass-border)',
                    background: 'color-mix(in srgb, var(--bg) 30%, transparent)',
                  }}
                >
                  <GutterNumbers lineCount={lineCount} />
                </div>
              )}
                <textarea
                  ref={textareaRef}
                  dir="auto"
                  value={content}
                  onChange={handleTextChange}
                  onKeyDown={handleKeyDown}
                  onScroll={handleTextareaScroll}
                  onContextMenu={handleEditorContextMenu}
                  onBlur={() => void flushSave()}
                  placeholder="First line is your note… Just start typing."
                  spellCheck={settings.spellCheck}
                  readOnly={isTrashView}
                  className="flex-1 min-w-0 min-h-0 p-8 bg-transparent placeholder:text-[var(--faint)] outline-none resize-none leading-relaxed"
                  style={{
                    color: 'var(--text)',
                    fontSize: `${editorFontSize}px`,
                    fontFamily: editorFontFamily,
                    // Pinned to 400 — the "Bold interface text" setting must
                    // never bold the note text.
                    fontWeight: 400,
                    lineHeight: 1.7,
                    textShadow: '0 0 12px rgba(255,255,255,0.02)',
                  }}
                />
              </div>
                <div
                  className="shrink-0 flex items-center justify-between gap-3 px-4 py-1.5 text-[10px] font-mono theme-faint tabular-nums"
                  style={{ borderTop: '1px solid var(--glass-border)' }}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    {/* Save status: compact, always visible, never truncated.
                        A failed save shows in red with the reason on hover. */}
                    {saveStatus === 'saving' ? (
                      <span className="flex items-center gap-1 theme-accent whitespace-nowrap">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        <span>Saving…</span>
                      </span>
                    ) : saveStatus === 'failed' ? (
                      <span
                        className="flex items-center gap-1 theme-danger whitespace-nowrap"
                        title={saveError || 'The file on disk could not be written. Your text is kept in the app — edit again to retry.'}
                      >
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--danger)' }} />
                        <span>Couldn&apos;t save</span>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 whitespace-nowrap">
                        <Check className="w-2.5 h-2.5" style={{ color: 'var(--ok)' }} />
                        <span>Autosaved</span>
                      </span>
                    )}
                    <span className="whitespace-nowrap truncate">Ln {totalLines} · {stats.words} words · {stats.characters} chars · {readingMinutes}m read</span>
                  </span>
                  <span className="whitespace-nowrap shrink-0">{editorFontLabel} · {isTrashView ? 'Read-only' : 'Markdown'}</span>
                </div>
            </div>
          )}

          {(viewMode === 'preview' || viewMode === 'split') && (
            <div
              className={`h-full overflow-y-auto p-8 glass-panel !rounded-2xl md-preview select-text min-h-0 ${viewMode === 'split' ? 'w-1/2' : 'w-full'}`}
              dir="auto"
            >
              <div
                dir="auto"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
                className="max-w-none text-sm leading-relaxed space-y-4"
                style={{ fontSize: `${editorFontSize}px` }}
                onClick={async (e) => {
                  // A task checkbox in the preview toggles the matching
                  // source line (data-task = its index among task items,
                  // document order). The box flips in the source, so the
                  // preview re-renders checked — no DOM state to keep in
                  // sync, and no focus is stolen from the editor.
                  const box = (e.target as HTMLElement).closest('input[type="checkbox"]');
                  if (box) {
                    const idx = Number(box.getAttribute('data-task'));
                    if (!Number.isNaN(idx)) toggleTaskAtIndex(idx);
                    return;
                  }
                  // Intercept link clicks inside the preview: javascript:/data:
                  // URLs are already stripped by the sanitizer, and external
                  // http(s) links open in the system browser via the Tauri
                  // opener.
                  const target = (e.target as HTMLElement).closest('a');
                  if (!target) return;
                  e.preventDefault();
                  const href = target.getAttribute('href') ?? '';
                  if (!href || href.startsWith('#')) return;
                  // Outside Tauri (browser preview) the opener plugin does
                  // not exist — open the link in a new tab instead of
                  // swallowing the click. hrefs here already passed the
                  // sanitizer's allowlist.
                  if (!isTauri()) {
                    window.open(href, '_blank', 'noopener,noreferrer');
                    return;
                  }
                  try {
                    const { openUrl } = await import('@tauri-apps/plugin-opener');
                    await openUrl(href);
                  } catch {
                    // Opener unavailable — ignore.
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>

      {editorMenu.isOpen &&
        createPortal(
          <div
            id="editor-context-menu"
            style={{
              position: 'fixed',
              left: `${Math.max(8, Math.min(editorMenu.x, window.innerWidth - 200 - 12))}px`,
              top: `${Math.max(8, Math.min(editorMenu.y, window.innerHeight - 180 - 12))}px`,
              zIndex: 99999,
            }}
            className="glass-menu w-48 p-1.5 text-xs select-none animate-menu-in"
          >
            <div className="flex flex-col gap-0.5">
              <button
                onClick={handleMenuCut}
                disabled={isTrashView || !getSelection().selected}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Scissors className="w-4 h-4 theme-faint" />
                <span>Cut</span>
                <span className="ml-auto text-[10px] theme-faint">Ctrl+X</span>
              </button>
              <button
                onClick={handleMenuCopy}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Copy className="w-4 h-4 theme-faint" />
                <span>Copy</span>
                <span className="ml-auto text-[10px] theme-faint">Ctrl+C</span>
              </button>
              <button
                onClick={handleMenuPaste}
                disabled={isTrashView}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <ClipboardPaste className="w-4 h-4 theme-faint" />
                <span>Paste</span>
                <span className="ml-auto text-[10px] theme-faint">Ctrl+V</span>
              </button>
              <div className="my-1" style={{ borderTop: '1px solid var(--glass-border)' }} />
              <button
                onClick={handleMenuSelectAll}
                className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-[var(--raised)] text-left transition-all duration-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span className="w-4 h-4 flex items-center justify-center theme-faint text-[11px] font-bold">A</span>
                <span>Select all</span>
                <span className="ml-auto text-[10px] theme-faint">Ctrl+A</span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </main>
  );
};
