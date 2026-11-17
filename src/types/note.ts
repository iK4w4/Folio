export interface Note {
  /** Bare file name, e.g. "2026-11-10_15-30-00_meeting-notes_a1b2.md". */
  fileName: string;
  /** Empty string for the Notes/ root, otherwise the subfolder name. */
  folder: string;
  content: string;
  /** ISO string. */
  createdAt: string;
  /** ISO string. */
  modifiedAt: string;
  /** Owned by the Rust backend (pins.json); the web preview mirrors it. */
  pinned: boolean;
}

export interface Folder {
  name: string;
  count: number;
}

export type SortMode = 'newest' | 'oldest' | 'az' | 'created';

/** Folio palette ids — mirrors PALETTES in src/lib/themes.ts. */
export type PaletteId =
  | 'forest' | 'ember' | 'sage' | 'lagoon' | 'ultraviolet' | 'indigo'
  | 'graphite' | 'violet' | 'bronze' | 'teal' | 'mist' | 'lavender'
  | 'royal' | 'tangerine' | 'amethyst' | 'rose';

/** Editor font family (Settings ▸ Editor font).
 *  'system' = the app font (Segoe UI stack), 'serif' = Georgia,
 *  'mono' = Cascadia Mono. The app ships no web fonts. */
export type EditorFontFamily = 'system' | 'serif' | 'mono';

export interface AppSettings {
  theme: 'dark' | 'light';
  /** Folio palette id (see src/lib/themes.ts). */
  palette: PaletteId;
  /** 90 to 150. */
  zoom: number;
  editorFontFamily: EditorFontFamily;
  /** Bolds the app's own labels, buttons, lists and menus — never the note text. */
  uiBold: boolean;
  spellCheck: boolean;
  lineNumbers: boolean;
  /** Glass intensity, 0–100 (Settings ▸ Glassiness). */
  glassiness: number;
  /** Editor text size in px (12–26, Settings ▸ Editor font size). */
  editorFontSize: number;
}

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  type: 'note' | 'folder' | 'trash-note';
  targetFileName?: string;
  targetFolder?: string;
}
