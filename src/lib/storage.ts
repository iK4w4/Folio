import { Note, AppSettings, Folder } from '../types/note';
import { generateNoteFileName, generateBackupText, parseBackupText, isValidBareMdName } from './utils';
import { PALETTES } from './themes';

// ---------------------------------------------------------------------------
// Typed Tauri bridge.
//
// Every invoke goes through `invokeTauri`, which throws when the desktop
// backend rejects a call — the UI surfaces the real error.
//
// DUAL-KEY CONTRACT: every multi-word arg is sent in BOTH snake_case and
// camelCase. The Rust backend reads snake_case and serde-ignores the extra
// camelCase key; a backend that only understands camelCase reads that one.
// With both keys present the save can never fail on casing.
// ---------------------------------------------------------------------------

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

// The backend's size limit counts UTF-8 BYTES; a JS string's length counts
// UTF-16 units, which undercounts non-Latin text roughly 2-3x (a ~2.1M-char
// Persian note is ~4.2 MB on disk). Measure the same way the backend does.
const utf8Encoder = new TextEncoder();
const utf8ByteLength = (s: string): number => utf8Encoder.encode(s).length;

async function invokeTauri<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error('Not running in Tauri');
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<T>(command, args);
}

// ---------------------------------------------------------------------------
// Web fallback (plain browser preview): localStorage is the store.
// ---------------------------------------------------------------------------

const NOTES_KEY = 'folio_data';
const SETTINGS_KEY = 'folio_settings';
const BACKUP_KEY = 'folio_all_notes_txt';
const FOLDERS_KEY = 'folio_folders';
const TRASH_KEY = 'folio_trash';
const PINS_KEY = 'folio_pins';

function parseNotes(raw: string | null): Note[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Normalize every entry: a hand-edited or corrupt mirror entry missing
    // a field (no `content`, a non-string `folder`) must degrade to an
    // empty note, never throw inside the list filter that reads those
    // fields on every render.
    const out: Note[] = [];
    for (const entry of parsed) {
      const n = normalizeNote(entry);
      if (n) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Coerce one stored note (mirror JSON or a backend payload) into a
 * well-formed Note. Returns null for entries without a usable file name.
 * Every field the UI reads — content, folder, timestamps, pinned — gets a
 * safe default so a malformed entry can never crash a render.
 */
function normalizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Partial<Note>;
  if (typeof n.fileName !== 'string' || !n.fileName) return null;
  return {
    fileName: n.fileName,
    folder: typeof n.folder === 'string' ? n.folder : '',
    content: typeof n.content === 'string' ? n.content : '',
    createdAt: typeof n.createdAt === 'string' ? n.createdAt : '',
    modifiedAt: typeof n.modifiedAt === 'string' ? n.modifiedAt : '',
    pinned: n.pinned === true,
  };
}

function getWebNotes(): Note[] {
  try {
    return parseNotes(localStorage.getItem(NOTES_KEY));
  } catch {
    return [];
  }
}

function saveWebNotes(notes: Note[]): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    // The backup text is a web-mode concern only. In Tauri mode the real
    // All Notes.txt lives on disk next to the exe.
    if (!isTauri()) localStorage.setItem(BACKUP_KEY, generateBackupText(notes));
  } catch (err) {
    console.error('Failed to save notes to localStorage:', err);
  }
}

function getWebTrash(): Note[] {
  try {
    return parseNotes(localStorage.getItem(TRASH_KEY));
  } catch {
    return [];
  }
}

function saveWebTrash(trash: Note[]): void {
  try {
    localStorage.setItem(TRASH_KEY, JSON.stringify(trash));
  } catch (err) {
    console.error('Failed to save trash to localStorage:', err);
  }
}

function readPins(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

// Pins are owned by Rust (pins.json) in Tauri. The web fallback keeps its
// own map in localStorage, but fetchNotes/fetchTrash only apply pins that
// came WITH the backend data — the local map must never override the
// backend's pinned flag.

function applyPins(notes: Note[]): Note[] {
  if (!notes || notes.length === 0) return notes || [];
  return notes.map((n) => ({ ...n, pinned: n.pinned ?? false }));
}

function applyWebPins(notes: Note[]): Note[] {
  const pins = readPins();
  if (!notes || notes.length === 0) return notes || [];
  return notes.map((n) => {
    const pinned = pins[n.fileName];
    if (typeof pinned === 'boolean') return { ...n, pinned };
    return { ...n, pinned: n.pinned ?? false };
  });
}

function moveWebNotesToTrash(fileNames: string[]): number {
  const nameSet = new Set(fileNames);
  const notes = getWebNotes();
  const toMove: Note[] = [];
  const remaining: Note[] = [];
  for (const n of notes) {
    if (nameSet.has(n.fileName)) toMove.push(n);
    else remaining.push(n);
  }
  if (toMove.length === 0) return 0;
  saveWebNotes(remaining);
  const trash = getWebTrash();
  const trashNames = new Set(trash.map((t) => t.fileName));
  for (const n of toMove) {
    if (!trashNames.has(n.fileName)) {
      trash.push(n);
      trashNames.add(n.fileName);
    }
  }
  saveWebTrash(trash);
  return toMove.length;
}

function pruneWebNotes(fileNames: string[]): void {
  const nameSet = new Set(fileNames);
  const notes = getWebNotes();
  const remaining = notes.filter((n) => !nameSet.has(n.fileName));
  if (remaining.length !== notes.length) saveWebNotes(remaining);
}

function pruneWebTrash(fileNames: string[]): void {
  const nameSet = new Set(fileNames);
  const trash = getWebTrash();
  const remaining = trash.filter((n) => !nameSet.has(n.fileName));
  if (remaining.length !== trash.length) saveWebTrash(remaining);
}

function restoreWebNote(fileName: string): boolean {
  const trash = getWebTrash();
  const lower = fileName.toLowerCase();
  const index = trash.findIndex((n) => n.fileName.toLowerCase() === lower);
  if (index === -1) return false;
  const restored = trash[index];
  if (!restored) return false;
  const notes = getWebNotes();
  // Never overwrite a live note with the same name. The trash copy stays put
  // so the user can rename/remove it.
  if (notes.some((n) => n.fileName.toLowerCase() === lower)) return false;
  saveWebTrash(trash.filter((_, i) => i !== index));
  notes.unshift({ ...restored, pinned: restored.pinned ?? false });
  saveWebNotes(notes);
  return true;
}

function deleteWebNotePermanent(fileName: string): boolean {
  let removed = false;
  const trash = getWebTrash();
  const newTrash = trash.filter((n) => n.fileName !== fileName);
  if (newTrash.length !== trash.length) {
    saveWebTrash(newTrash);
    removed = true;
  }
  const notes = getWebNotes();
  const newNotes = notes.filter((n) => n.fileName !== fileName);
  if (newNotes.length !== notes.length) {
    saveWebNotes(newNotes);
    removed = true;
  }
  return removed;
}

function storageError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Reads. In Tauri the backend is the source of truth; the localStorage
// mirror is only consulted to recover text a failed save parked there.
// ---------------------------------------------------------------------------

export async function fetchNotes(): Promise<Note[]> {
  if (!isTauri()) {
    const all = getWebNotes();
    const trashNames = new Set(getWebTrash().map((n) => n.fileName));
    return applyWebPins(all.filter((n) => !trashNames.has(n.fileName)));
  }

  const backend = await invokeTauri<Note[]>('get_notes');
  if (!Array.isArray(backend)) {
    throw new Error('The backend returned an unexpected notes payload.');
  }
  // Normalize at the boundary too: a malformed backend entry must degrade
  // to an empty note, never reach the list with an undefined `content`.
  const normalized: Note[] = [];
  for (const entry of backend) {
    const n = normalizeNote(entry);
    if (n) normalized.push(n);
  }
  const backendNotes = normalized;

  // Merge the localStorage mirror by newest modifiedAt. A failed save parks
  // the text in the mirror so it is never lost; without this merge a later
  // successful fetch would return only the stale backend copy and the parked
  // text would vanish on the next refresh. Only backend notes are returned
  // (so a deleted note can never resurrect from the mirror); for a note
  // present in both, the newer modifiedAt wins and its content is taken
  // from the mirror, while folder/pins stay authoritative from the backend.
  const mirror = new Map(getWebNotes().map((n) => [n.fileName, n]));
  const merged = backendNotes.map((b) => {
    const m = mirror.get(b.fileName);
    if (m && m.modifiedAt && b.modifiedAt) {
      // Parse before comparing: Rust timestamps are RFC3339 with a local
      // offset ("+08:00") while the mirror uses UTC "Z". A raw string
      // compare would rank those incorrectly.
      const mirrorTime = Date.parse(m.modifiedAt);
      const backendTime = Date.parse(b.modifiedAt);
      const mirrorIsNewer =
        Number.isFinite(mirrorTime) && Number.isFinite(backendTime)
          ? mirrorTime > backendTime
          : m.modifiedAt > b.modifiedAt;
      if (mirrorIsNewer) {
        return { ...b, content: m.content, modifiedAt: m.modifiedAt };
      }
    }
    return b;
  });
  return applyPins(merged);
}

export async function fetchTrash(): Promise<Note[]> {
  if (!isTauri()) return applyWebPins(getWebTrash());

  const backend = await invokeTauri<Note[]>('get_trash');
  if (!Array.isArray(backend)) {
    throw new Error('The backend returned an unexpected trash payload.');
  }
  const normalized: Note[] = [];
  for (const entry of backend) {
    const n = normalizeNote(entry);
    if (n) normalized.push(n);
  }
  return applyPins(normalized);
}

function readLocalFolderNames(): string[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY) || '[]';
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim());
    }
  } catch {
    // ignore corrupt list
  }
  return [];
}

function writeLocalFolderNames(names: string[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(names));
  } catch (e) {
    console.warn('Failed to save folders list:', e);
  }
}

function fetchWebFolders(): Folder[] {
  const explicitFolders = readLocalFolderNames();
  const notes = getWebNotes();
  const folderCounts = new Map<string, number>();
  explicitFolders.forEach((name) => folderCounts.set(name, 0));
  notes.forEach((note) => {
    if (note.folder && note.folder.trim()) {
      const folderName = note.folder.trim();
      folderCounts.set(folderName, (folderCounts.get(folderName) || 0) + 1);
      if (!explicitFolders.includes(folderName)) explicitFolders.push(folderName);
    }
  });
  writeLocalFolderNames(explicitFolders);
  return Array.from(folderCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchFolders(): Promise<Folder[]> {
  if (!isTauri()) return fetchWebFolders();

  // The backend is the source of truth in Tauri mode. Unioning localStorage
  // folder names on top would keep a folder that was deleted externally (or
  // left over from a web preview) reappearing as a phantom 0-count folder.
  const backend = await invokeTauri<Folder[]>('get_folders');
  if (!Array.isArray(backend)) {
    throw new Error('The backend returned an unexpected folders payload.');
  }
  return [...backend].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export async function createNote(content: string, folder = ''): Promise<Note> {
  if (utf8ByteLength(content) > 4 * 1024 * 1024) {
    throw new Error('Note is too large to save (4 MB limit).');
  }
  if (isTauri()) {
    // The backend generates the file name; the frontend never invents one
    // the backend did not confirm.
    return await invokeTauri<Note>('create_note', { content, folder: folder || '' });
  }
  const fileName = generateNoteFileName(content);
  const now = new Date().toISOString();
  const newNote: Note = {
    fileName,
    folder: folder || '',
    content,
    createdAt: now,
    modifiedAt: now,
    pinned: false,
  };
  const notes = getWebNotes();
  const trash = getWebTrash();
  if (trash.some((n) => n.fileName === fileName)) {
    saveWebTrash(trash.filter((n) => n.fileName !== fileName));
  }
  saveWebNotes([newNote, ...notes]);
  return newNote;
}

/**
 * Park text in the localStorage mirror so it is never lost when a save is
 * refused or the disk write fails. The next successful fetch surfaces it via
 * the newest-modifiedAt merge. The note's real folder is kept so it surfaces
 * in the right place instead of silently landing in Root.
 */
function parkInMirror(fileName: string, folder: string, content: string): void {
  const notes = getWebNotes();
  const index = notes.findIndex((n) => n.fileName === fileName);
  const now = new Date().toISOString();
  if (index !== -1) {
    const existing = notes[index];
    if (existing) {
      notes[index] = { ...existing, content, modifiedAt: now };
    }
    saveWebNotes(notes);
  } else {
    saveWebNotes([{ fileName, folder, content, createdAt: now, modifiedAt: now, pinned: false }, ...notes]);
  }
}

export async function saveNote(fileName: string, content: string, folder = ''): Promise<{ ok: boolean; error?: string }> {
  // The guard mirrors the backend's is_safe_bare_md_name exactly.
  if (!isValidBareMdName(fileName)) {
    console.error('Invalid note file name rejected:', fileName);
    return { ok: false, error: 'Invalid note file name.' };
  }
  if (utf8ByteLength(content) > 4 * 1024 * 1024) {
    return { ok: false, error: 'Note is too large to save (4 MB limit).' };
  }
  if (isTauri()) {
    try {
      const ok = await invokeTauri<boolean>('save_note', { file_name: fileName, fileName, content });
      if (ok) {
        // A successful save must prune the parked copy, or the stale text
        // sits in localStorage forever.
        pruneWebNotes([fileName]);
        return { ok: true };
      }
      // The backend refused the save (note not found on disk). Park the text
      // so the typed text is never silently dropped.
      parkInMirror(fileName, folder, content);
      return { ok: false, error: 'The backend refused the save (note not found on disk).' };
    } catch (err) {
      const msg = storageError(err);
      console.error('save_note failed:', err);
      // Persist the text into the mirror so it is never lost even if the
      // disk write failed; the next successful fetch surfaces it.
      parkInMirror(fileName, folder, content);
      return { ok: false, error: msg || 'The disk write failed.' };
    }
  }
  const notes = getWebNotes();
  const index = notes.findIndex((n) => n.fileName === fileName);
  if (index === -1) {
    console.warn('Attempted to save non-existent note (preventing resurrection):', fileName);
    return { ok: false, error: 'Note not found.' };
  }
  const existing = notes[index];
  if (!existing) {
    console.warn('Attempted to save non-existent note (preventing resurrection):', fileName);
    return { ok: false, error: 'Note not found.' };
  }
  existing.content = content;
  existing.modifiedAt = new Date().toISOString();
  saveWebNotes(notes);
  return { ok: true };
}

export async function deleteNote(fileName: string): Promise<boolean> {
  if (isTauri()) {
    const ok = await invokeTauri<boolean>('delete_note', { file_name: fileName, fileName });
    if (ok) pruneWebNotes([fileName]);
    return ok;
  }
  // A delete of a note that is not there is a failure, not a success.
  return moveWebNotesToTrash([fileName]) > 0;
}

export async function restoreNote(fileName: string): Promise<boolean> {
  if (isTauri()) {
    const ok = await invokeTauri<boolean>('restore_note', { file_name: fileName, fileName });
    if (ok) pruneWebTrash([fileName]);
    return ok;
  }
  return restoreWebNote(fileName);
}

export async function deleteNotePermanent(fileName: string): Promise<boolean> {
  if (isTauri()) {
    const ok = await invokeTauri<boolean>('delete_note_permanent', { file_name: fileName, fileName });
    if (ok) {
      pruneWebTrash([fileName]);
      pruneWebNotes([fileName]);
    }
    return ok;
  }
  return deleteWebNotePermanent(fileName);
}

export async function emptyTrash(): Promise<boolean> {
  if (isTauri()) {
    const ok = await invokeTauri<boolean>('empty_trash');
    if (ok) saveWebTrash([]);
    return ok;
  }
  saveWebTrash([]);
  return true;
}

export async function exportNote(fileName: string): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>('export_note', { file_name: fileName, fileName });
  }
  throw new Error('Export needs the desktop app.');
}

export async function exportAllNotes(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>('export_all_notes');
  }
  throw new Error('Export needs the desktop app.');
}

export async function duplicateNote(source: Note): Promise<Note> {
  return await createNote(source.content, source.folder || '');
}

export async function moveNotes(fileNames: string[], targetFolder: string): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>('move_notes', {
      file_names: fileNames,
      fileNames,
      target_folder: targetFolder,
      targetFolder,
    });
  }
  const nameSet = new Set(fileNames);
  const notes = getWebNotes();
  let moved = false;
  const updated = notes.map((note) => {
    if (!nameSet.has(note.fileName)) return note;
    moved = true;
    return { ...note, folder: targetFolder, modifiedAt: new Date().toISOString() };
  });
  // A move that matched nothing is a failure, not a success — and it must
  // not rewrite the store (and regenerate the backup) for no reason.
  if (moved) saveWebNotes(updated);
  return moved;
}

export async function togglePinNote(fileName: string, pinned: boolean): Promise<boolean> {
  // Rust is the source of truth in Tauri (pins.json). The localStorage pin
  // map is the web-preview mirror only, so it is never written here.
  if (isTauri()) {
    return await invokeTauri<boolean>('toggle_pin', { file_name: fileName, fileName, pinned });
  }
  const notes = getWebNotes();
  const note = notes.find((n) => n.fileName === fileName);
  // Check first: writing the pin map for a note that does not exist would
  // leave an orphan entry that later applies to a different note reusing
  // the same file name.
  if (!note) return false;
  const pins = readPins();
  if (pinned) pins[fileName] = true;
  else delete pins[fileName];
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch (e) {
    console.warn('Failed to save pin map:', e);
  }
  note.pinned = pinned;
  saveWebNotes(notes);
  return true;
}

const RESERVED_FOLDER_BASES = ['CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'];

/**
 * Validate a folder name the same way on both sides. Invalid names are
 * rejected with a clear reason instead of being silently rewritten, and the
 * caller uses the canonical (trimmed) name returned here.
 */
function validateFolderName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: 'Enter a folder name.' };
  if (/[<>:"/\\|?*]/.test(name)) {
    return { ok: false, error: 'Folder names cannot contain < > : " / \\ | ? *' };
  }
  if (/[\x00-\x1F\x7F-\x9F]/.test(name)) {
    return { ok: false, error: 'Folder names cannot contain control characters.' };
  }
  if (name === '.' || name === '..') return { ok: false, error: 'That folder name is not allowed.' };
  if (name.endsWith('.')) return { ok: false, error: 'Folder names cannot end with a dot.' };
  // "Root" is the backup label for notes with no folder: a real folder
  // with that name would be written to the backup as FOLDER: Root and
  // restored into the root instead, so it can never be a folder name.
  if (name.toLowerCase() === 'root') {
    return { ok: false, error: '"Root" is reserved for notes with no folder.' };
  }
  // The backend caps a folder name at 100 characters; accepting a longer
  // name here would only fail later, at the backend call.
  if (Array.from(name).length > 100) {
    return { ok: false, error: 'Folder names cannot be longer than 100 characters.' };
  }
  const base = name.split('.')[0] ?? '';
  if (RESERVED_FOLDER_BASES.includes(base.toUpperCase())) {
    return { ok: false, error: `"${base}" is a reserved Windows name.` };
  }
  return { ok: true, name };
}

export async function createFolder(folderName: string): Promise<{ ok: boolean; error?: string; name?: string }> {
  const validated = validateFolderName(folderName);
  if (!validated.ok) return { ok: false, error: validated.error };
  const cleanName = validated.name;
  if (isTauri()) {
    // A backend failure is surfaced, never masked as success — a rejected
    // create_folder must not look like the folder was made.
    try {
      const ok = await invokeTauri<boolean>('create_folder', { folder_name: cleanName, folderName: cleanName });
      if (ok) return { ok: true, name: cleanName };
      return { ok: false, error: `Could not create folder "${cleanName}".` };
    } catch (err) {
      return { ok: false, error: storageError(err) || 'Could not create that folder.' };
    }
  }
  const local = readLocalFolderNames();
  // Case-insensitive like the rename path: "work" next to "Work" is the
  // same folder on Windows. An exact-case repeat stays idempotent (the
  // folder is just selected).
  if (
    local.some((f) => f.toLowerCase() === cleanName.toLowerCase() && f !== cleanName)
  ) {
    return { ok: false, error: 'A folder with that name already exists.' };
  }
  if (!local.includes(cleanName)) {
    local.push(cleanName);
    writeLocalFolderNames(local);
  }
  return { ok: true, name: cleanName };
}

export async function renameFolder(oldName: string, newName: string): Promise<boolean> {
  const validated = validateFolderName(newName);
  if (!validated.ok) throw new Error(validated.error);
  const cleanNew = validated.name;
  if (cleanNew === oldName) return false;
  if (isTauri()) {
    try {
      const ok = await invokeTauri<boolean>('rename_folder', {
        old_name: oldName,
        oldName,
        new_name: cleanNew,
        newName: cleanNew,
      });
      if (ok) {
        writeLocalFolderNames(readLocalFolderNames().map((f) => (f === oldName ? cleanNew : f)));
      }
      return ok;
    } catch (err) {
      console.error('rename_folder failed:', err);
      // Surface the real reason instead of reporting a silent false, so the
      // caller can show it and the UI does not update as if it succeeded.
      throw new Error(storageError(err) || 'Could not rename that folder.');
    }
  }
  // The web path must refuse a collision too — renaming onto an existing
  // folder would merge two folders' notes under one name.
  if (
    readLocalFolderNames().some(
      (f) => f.toLowerCase() === cleanNew.toLowerCase() && f !== oldName
    )
  ) {
    throw new Error('A folder with that name already exists.');
  }
  const notes = getWebNotes().map((note) => (note.folder === oldName ? { ...note, folder: cleanNew } : note));
  saveWebNotes(notes);
  writeLocalFolderNames(readLocalFolderNames().map((f) => (f === oldName ? cleanNew : f)));
  return true;
}

export async function deleteFolder(folderName: string, deleteContainedNotes = false): Promise<boolean> {
  if (isTauri()) {
    try {
      const ok = await invokeTauri<boolean>('delete_folder', {
        folder_name: folderName,
        folderName,
        delete_contained_notes: deleteContainedNotes,
        deleteContainedNotes,
      });
      if (ok) {
        writeLocalFolderNames(readLocalFolderNames().filter((f) => f !== folderName));
      }
      return ok;
    } catch (err) {
      console.error('delete_folder failed:', err);
      throw new Error(storageError(err) || 'Could not delete that folder.');
    }
  }
  const notes = getWebNotes();
  const updatedNotes = deleteContainedNotes
    ? notes.filter((n) => n.folder !== folderName)
    : notes.map((n) => (n.folder === folderName ? { ...n, folder: '' } : n));
  saveWebNotes(updatedNotes);
  writeLocalFolderNames(readLocalFolderNames().filter((f) => f !== folderName));
  return true;
}

// ---------------------------------------------------------------------------
// Settings.
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  palette: 'forest',
  zoom: 100,
  editorFontFamily: 'system',
  uiBold: false,
  spellCheck: true,
  lineNumbers: false,
  glassiness: 70,
  editorFontSize: 14,
};

// The valid palette ids come from the palette list itself, so a new
// palette only has to be added in one place.
const PALETTE_IDS = new Set<string>(PALETTES.map((p) => p.id));

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSettings(stored: unknown): AppSettings {
  const base: Partial<AppSettings> =
    stored && typeof stored === 'object' ? (stored as Partial<AppSettings>) : {};
  return {
    theme: base.theme === 'light' || base.theme === 'dark' ? base.theme : DEFAULT_SETTINGS.theme,
    palette:
      typeof base.palette === 'string' && PALETTE_IDS.has(base.palette)
        ? base.palette
        : DEFAULT_SETTINGS.palette,
    zoom: clamp(base.zoom, 90, 150, DEFAULT_SETTINGS.zoom),
    editorFontFamily:
      base.editorFontFamily === 'system' ||
      base.editorFontFamily === 'serif' ||
      base.editorFontFamily === 'mono'
        ? base.editorFontFamily
        : DEFAULT_SETTINGS.editorFontFamily,
    uiBold: typeof base.uiBold === 'boolean' ? base.uiBold : DEFAULT_SETTINGS.uiBold,
    spellCheck: typeof base.spellCheck === 'boolean' ? base.spellCheck : DEFAULT_SETTINGS.spellCheck,
    lineNumbers: typeof base.lineNumbers === 'boolean' ? base.lineNumbers : DEFAULT_SETTINGS.lineNumbers,
    glassiness: clamp(base.glassiness, 0, 100, DEFAULT_SETTINGS.glassiness),
    editorFontSize: clamp(base.editorFontSize, 12, 26, DEFAULT_SETTINGS.editorFontSize),
  };
}

export async function fetchSettings(): Promise<AppSettings> {
  if (isTauri()) {
    try {
      const res = await invokeTauri<AppSettings>('get_settings');
      if (res) return sanitizeSettings(res);
    } catch {
      // fall through to localStorage
    }
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Persist settings. Returns false when the durable write failed, so the
 * caller can say so instead of acting as if the settings were saved: the
 * desktop backend is the store in Tauri mode, localStorage in the browser
 * preview. A failed backend write leaves the in-memory settings applied
 * for this session only.
 */
export async function persistSettings(settings: AppSettings): Promise<boolean> {
  const sanitized = sanitizeSettings(settings);
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
  } catch (err) {
    console.error('Failed to save settings:', err);
    if (!isTauri()) return false;
  }
  if (isTauri()) {
    try {
      await invokeTauri('save_settings', { settings: sanitized });
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Backup restore + raw backup.
// ---------------------------------------------------------------------------

export async function restoreFromBackup(): Promise<{ restoredCount: number; message: string }> {
  if (isTauri()) {
    return await invokeTauri<{ restoredCount: number; message: string }>('restore_backup');
  }
  const backupText = localStorage.getItem(BACKUP_KEY);
  if (!backupText) {
    return { restoredCount: 0, message: 'No backup found in All Notes.txt' };
  }
  const existingNotes = getWebNotes();
  // Case-insensitive: the filesystem is case-insensitive on Windows, so
  // "NOTE.MD" and "note.md" are the same note.
  const existingNames = new Set(existingNotes.map((n) => n.fileName.toLowerCase()));
  const trashNames = new Set(getWebTrash().map((n) => n.fileName.toLowerCase()));
  const parsed = parseBackupText(backupText);
  let restoredCount = 0;
  const newNotes = [...existingNotes];
  for (const item of parsed) {
    if (
      item.fileName &&
      !existingNames.has(item.fileName.toLowerCase()) &&
      !trashNames.has(item.fileName.toLowerCase()) &&
      isValidBareMdName(item.fileName)
    ) {
      newNotes.push({
        fileName: item.fileName,
        folder: item.folder || '',
        content: item.content || '',
        createdAt: item.createdAt || new Date().toISOString(),
        modifiedAt: item.modifiedAt || new Date().toISOString(),
        pinned: false,
      });
      restoredCount++;
    }
  }
  if (restoredCount > 0) saveWebNotes(newNotes);
  return {
    restoredCount,
    message:
      restoredCount > 0
        ? `Successfully restored ${restoredCount} note(s) from All Notes.txt without overwriting existing files.`
        : 'All notes from backup already exist. No missing notes to restore.',
  };
}

/** Copy the live All Notes.txt backup into Exports/ (desktop only). */
export async function exportBackupCopy(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>('export_backup');
  }
  // Browser preview: hand the generated backup text back to the caller.
  return generateBackupText(getWebNotes());
}

/** Absolute path of the data folder (next to the executable). */
export async function getDataDirPath(): Promise<string> {
  if (isTauri()) {
    return await invokeTauri<string>('get_app_dir_path');
  }
  return 'Browser preview — files live in localStorage.';
}

/**
 * Open the data folder. The Rust `open_data_dir` command opens exactly the
 * computed data directory; the opener plugin's `open_path` has no path scope
 * and is rejected by Tauri v2.
 */
export async function openDataDir(): Promise<void> {
  if (!isTauri()) throw new Error('Not available in the browser preview.');
  await invokeTauri<void>('open_data_dir');
}

// ---------------------------------------------------------------------------
// Native WebView zoom. Tauri -> Rust set_window_zoom (WebView2 zoom factor);
// browser preview -> CSS zoom fallback only (never used by the real app).
// ---------------------------------------------------------------------------

export async function setWindowZoom(zoom: number): Promise<void> {
  const clamped = Math.min(150, Math.max(90, Math.round(zoom)));
  if (isTauri()) {
    try {
      await invokeTauri<boolean>('set_window_zoom', { zoom: clamped });
      return;
    } catch (err) {
      // Do NOT fall back to CSS zoom inside the desktop app. CSS zoom is
      // non-standard and overflows the overflow-hidden window at high values,
      // so the zoom control itself can end up off-screen with no way back.
      // A failed native zoom keeps the current scale; the error is logged.
      console.warn('set_window_zoom failed, keeping the current zoom:', err);
      return;
    }
  }
  // Browser preview only: CSS zoom is the only thing available there.
  document.documentElement.style.zoom = (clamped / 100).toString();
}
