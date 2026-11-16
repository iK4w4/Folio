import { Note } from '../types/note';

/**
 * Generate a unique, safe file name for a note.
 * Supports Persian, Arabic, Cyrillic, CJK, and Latin text.
 * Adds a timestamp and a random hex suffix to guarantee uniqueness.
 *
 * The rules mirror the Rust generator (generate_safe_file_name):
 * forbidden Windows path characters and control characters become spaces,
 * dots become word separators, and the result is truncated to 36 characters.
 */
export function generateNoteFileName(content: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const datePrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

  // Extract first non-empty line
  const firstLine = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';

  // Keep Unicode letters/numbers and spaces; forbidden Windows characters
  // and control characters become a SPACE so the words stay separate.
  // Code points are sliced, so no surrogate pair is split mid-way.
  const cleaned = firstLine
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F-\x9F]/g, ' ')
    .replace(/\./g, ' ')
    .trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  const clean = Array.from(words.join('-')).slice(0, 36).join('');

  // Random hex from 4 bytes (32 bits). `>>> 0` keeps the result unsigned —
  // a byte >= 128 would otherwise produce a negative hex string.
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const value =
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0;
  const hex = value.toString(16).padStart(8, '0');

  if (!clean || clean === '-') {
    return `${datePrefix}_note_${hex}.md`;
  }

  return `${datePrefix}_${clean}_${hex}.md`;
}

/**
 * Strip inline Markdown down to its visible text, for display contexts
 * (note-list title/preview, A-Z sort): emphasis, strikethrough, code
 * spans, links and images read as the words they render. Hashtags are NOT
 * touched — a `#tag` is content, not a marker, and extractNoteTags reads
 * it from the raw text.
 */
function stripInlineMarkdown(text: string): string {
  return text
    // Images first (they contain a link-shaped tail): ![alt](url) -> alt.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links: [text](url) -> text.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Paired markers only, so a lone marker in ordinary text survives.
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(\*\*)(.+?)\1/g, '$2')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`{1,3}([^`]+?)`{1,3}/g, '$1')
    // Single-star / single-underscore emphasis: the inner text must not
    // start or end with a space (a flanking space means it is not
    // emphasis — "2 * 3" stays), and underscores must not sit inside a
    // word, or snake_case identifiers get mangled.
    .replace(/\*(\S(?:[^*]*\S)?)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(\S(?:[^_]*\S)?)_(?![\p{L}\p{N}_])/gu, '$1');
}

/**
 * Strip line-leading markers that are structure, not content: heading
 * hashes, list bullets/numbers, quote markers, a lone code fence. The
 * heading rule requires the space after the hashes, so a `#tag` first
 * line keeps its hash.
 */
function stripLineMarkers(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/^```.*$/, '');
}

/**
 * Extract a note's display title and preview text.
 */
export function getNoteDisplay(content: string): { title: string; preview: string; isUntitled: boolean } {
  if (!content || !content.trim()) {
    return { title: 'Empty note', preview: 'No additional text', isUntitled: true };
  }

  const lines = content.split('\n');
  const firstNonEmptyIndex = lines.findIndex((l) => l.trim().length > 0);

  if (firstNonEmptyIndex === -1) {
    return { title: 'Empty note', preview: 'No additional text', isUntitled: true };
  }

  const rawTitle = (lines[firstNonEmptyIndex] ?? '').trim();
  // Show the visible text, not the raw Markdown: "**There**" reads as
  // "There" in the list. Falls back to the raw line when stripping would
  // leave nothing (a line that was only markers).
  const title = stripInlineMarkdown(stripLineMarkers(rawTitle)).trim() || rawTitle;

  const remaining = lines
    .slice(firstNonEmptyIndex + 1)
    .map((l) => stripInlineMarkdown(stripLineMarkers(l.trim())).trim())
    .filter(Boolean);
  // Slice by code point so an emoji on the boundary is never split into
  // a lone surrogate.
  const preview =
    remaining.length > 0
      ? Array.from(remaining.join(' ')).slice(0, 120).join('')
      : 'No additional text';

  return { title, preview, isUntitled: false };
}

/**
 * Extract hashtags (#tag) from content. Supports Unicode, Persian, and
 * Arabic letters.
 */
export function extractNoteTags(content: string): string[] {
  if (!content) return [];
  // Use the capture group, not the whole match: the match includes the
  // separator before the '#', so the group is what holds the bare tag
  // ('("#hello")' gives 'hello', not '("#hello').
  const matches = content.matchAll(/(?:^|[\s\u200B\u200D"'(>\[]+)#([\p{L}\p{N}_-]+)/gu);
  const unique = new Set<string>();
  for (const m of matches) {
    const cleanTag = m[1] ?? '';
    // Require at least one letter so "#123" doesn't count as a tag.
    if (cleanTag.length > 0 && cleanTag.length < 30 && /\p{L}/u.test(cleanTag)) {
      unique.add(cleanTag);
    }
  }
  return Array.from(unique).slice(0, 5);
}

/**
 * Live stats for the editor: words, characters, reading time.
 */
export function calculateTextStats(text: string) {
  if (!text || !text.trim()) {
    return { words: 0, characters: 0, readingTimeMinutes: 0 };
  }

  // Count words across languages including CJK and Persian/Arabic.
  const words = (text.trim().match(/[\p{L}\p{N}]+/gu) || []).length;
  const characters = Array.from(text).length;
  const readingTimeMinutes = words === 0 ? 0 : Math.ceil(words / 200);

  return { words, characters, readingTimeMinutes };
}

/**
 * Format a date for display in note cards and headers.
 */
export function formatNoteDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'Recently';

    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    // Future dates (clock skew) count as "Just now".
    const diffMins = Math.floor(Math.max(0, diffMs) / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
  } catch {
    return 'Recently';
  }
}

/**
 * Build the 'All Notes.txt' atomic backup content.
 *
 * Framing matches the Rust writer byte for byte:
 * "divider\n<header>\ndivider\n\n{content}\n\n" with no separator between
 * entries, so a backup written by one side and restored by the other keeps
 * its exact byte count.
 */
export function generateBackupText(notes: Note[]): string {
  const divider = '='.repeat(80);
  const header = `# FOLIO BACKUP - ATOMIC ALL NOTES\n# Total Notes: ${notes.length}\n# Exported At: ${new Date().toISOString()}\n# Format: Plain Markdown with dividers\n\n`;

  const entries = notes
    .map(
      (note) =>
        `${divider}\nFILE: ${note.fileName} | FOLDER: ${note.folder || 'Root'} | CREATED: ${note.createdAt} | MODIFIED: ${note.modifiedAt}\n${divider}\n\n${note.content}\n\n`
    )
    .join('');

  return header + entries;
}

/**
 * Parse 'All Notes.txt' for the restore functionality.
 *
 * Only a complete `divider + FILE: header + divider` triplet starts a new
 * entry, so a note body containing a line of 40+ '=' characters (a Markdown
 * setext underline or a horizontal divider) is never cut in half. The Rust
 * parser matches the same triplets.
 */
export function parseBackupText(backupText: string): Partial<Note>[] {
  if (!backupText || !backupText.trim()) return [];

  const headerRe = /^={40,}\r?\n(FILE:\s*[^\r\n]+)\r?\n={40,}\r?\n/gm;
  const matches = Array.from(backupText.matchAll(headerRe));
  const parsedNotes: Partial<Note>[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!match || match.index === undefined) continue;
    const headerLine = (match[1] ?? '').trim();
    const bodyStart = match.index + match[0].length;
    const bodyEnd = i + 1 < matches.length ? (matches[i + 1]?.index ?? backupText.length) : backupText.length;

    // Header line: FILE: ... | FOLDER: ... | CREATED: ... | MODIFIED: ...
    // Each value runs up to the next '|' (folders may contain spaces).
    const fields = new Map<string, string>();
    for (const part of headerLine.split('|')) {
      const m = part.match(/^\s*(FILE|FOLDER|CREATED|MODIFIED)\s*:\s*(.*)$/i);
      if (m) fields.set(String(m[1]).toUpperCase(), String(m[2]).trim());
    }
    const fileMatch = fields.get('FILE');
    const folderRaw = fields.get('FOLDER') ?? 'Root';
    const createdRaw = fields.get('CREATED');
    const modifiedRaw = fields.get('MODIFIED');
    if (!fileMatch) continue;

    const fileName = fileMatch.trim();
    const folder = folderRaw === 'Root' ? '' : folderRaw;
    const createdAt = createdRaw && createdRaw.trim() ? createdRaw.trim() : new Date().toISOString();
    const modifiedAt = modifiedRaw && modifiedRaw.trim() ? modifiedRaw.trim() : new Date().toISOString();

    // Strip EXACTLY the writer's framing: ONE leading newline and ONE
    // trailing newline pair. The note's own leading/trailing blank lines
    // survive, because the framing is removed by count and not by trimming.
    let content = backupText.slice(bodyStart, bodyEnd);
    content = content.replace(/^\r?\n/, '').replace(/\r?\n\r?\n$/, '');

    // Case-insensitive: the filesystem is case-insensitive on Windows, so
    // "NOTE.MD" and "note.md" are the same note.
    const key = fileName.toLowerCase();
    if (isValidBareMdName(fileName) && !seen.has(key)) {
      seen.add(key);
      parsedNotes.push({
        fileName,
        folder,
        content,
        createdAt,
        modifiedAt
      });
    }
  }

  return parsedNotes;
}

/**
 * Validate a bare "*.md" file name.
 *
 * Mirrors the backend's is_safe_bare_md_name: one path component, no
 * separators, no NTFS ADS colon, no control characters, no trailing dot or
 * space, no reserved Windows device name, and at most 200 UTF-8 bytes.
 *
 * A ".." *inside* the name is allowed — the name is used as a single path
 * component (Notes/<name>), so it cannot traverse anywhere.
 */
export function isValidBareMdName(name: string): boolean {
  if (!name || !name.toLowerCase().endsWith('.md')) return false;
  // The backend measures the name in UTF-8 BYTES (Rust's str::len), so the
  // two sides must measure it the same way.
  if (new TextEncoder().encode(name).length > 200) return false;
  if (name.includes('/') || name.includes('\\') || name.includes(':')) {
    return false;
  }
  // The C0 AND C1 control ranges, exactly like the backend's is_control().
  if (/[<>"|?*]/.test(name) || /[\x00-\x1F\x7F-\x9F]/.test(name)) return false;
  const stem = name.slice(0, -3);
  if (!stem || stem.startsWith('.') || stem.endsWith('.') || stem.endsWith(' ')) return false;
  if (stem === '..') return false;
  const reserved = ['CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'];
  // Windows reserves these with or without an extension — "CON.foo.md"
  // is reserved just like "CON.md".
  if (reserved.includes(stem.split('.')[0]?.toUpperCase() ?? '')) return false;
  return true;
}

// --- HTML sanitization -----------------------------------------------------
//
// marked output is rendered via dangerouslySetInnerHTML in Editor.tsx, so
// sanitizeMarkdownHtml() runs first. The sanitizer is a DOM-based allowlist
// (parse → walk → rebuild, never regex): it models what the browser will
// actually parse, so mXSS, nested foreign content, and entity-encoded
// schemes cannot slip past.
//
// Rules:
// 1. Hostile elements (script/style/iframe/object/embed/form/base/… and
//    declarative-hostile svg/math) are dropped with their contents.
// 2. Only safe presentational/semantic tags pass; everything else is
//    escaped to text, so no raw author HTML reaches innerHTML except
//    markdown's own generated elements.
// 3. Attributes: only href/src/alt/title on a/img survive, and the URL is
//    entity-decoded + scheme-checked. Remote images are blocked unless
//    data:image/*, so the app stays offline (no IP leak, no tracking pixels).
// 4. All links get rel="noopener noreferrer" — external navigation is
//    intercepted in Editor.tsx's click handler (Tauri opener).

const SAFE_TAGS = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'blockquote', 'pre', 'code', 'em', 'strong', 'a', 'img', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
  // Strikethrough (~~text~~) renders as <del>.
  'del', 's',
]);

const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'applet',
  'frame', 'frameset', 'base', 'link', 'meta', 'title', 'noscript',
  'template', 'slot', 'portal', 'svg', 'math', 'video', 'audio',
  'button', 'input', 'select', 'textarea', 'details', 'dialog', 'body',
  'head', 'html', 'canvas', 'map', 'area', 'aside', 'fieldset', 'legend',
  'summary', 'source', 'track', 'bgsound',
]);

function decodeUrl(value: string): string {
  // Decode numeric/hex entities the way the browser does before scheme
  // resolution, so "java&#115;cript:" cannot hide a javascript: URL.
  return value
    .replace(/&#(x?[0-9a-fA-F]+);?/g, (_m, entity: string) => {
      const code = entity.toLowerCase().startsWith('x')
        ? parseInt(entity.slice(1), 16)
        : parseInt(entity, 10);
      return Number.isFinite(code) ? String.fromCharCode(Math.max(0, Math.min(0x10FFFF, code))) : '';
    })
    .trim()
    .replace(/[\u0000-\u0020\u007F-\u009F\u200B-\u200D\uFEFF]+/g, '')
    .toLowerCase();
}

function isSafeUrl(value: string, kind: 'href' | 'src'): boolean {
  const v = decodeUrl(value);
  if (!v) return false;

  if (kind === 'src') {
    if (v.startsWith('data:')) {
      // Only raster images, and only with a real `;` or `,` after the
      // media type — "data:image/pngfoo" is not a PNG.
      return /^data:image\/(?:png|jpeg|jpg|gif|webp)(?:;|,)/.test(v);
    }
    if (v.startsWith('http://') || v.startsWith('https://') || v.startsWith('//')) {
      return false;
    }
    // Only relative non-scheme paths for local assets.
    return !/^[a-z][a-z0-9+.-]*:/i.test(v);
  }

  // Strict allowlist for href: safe web/contact protocols, anchors, or
  // relative paths. Any other scheme (smb://, ms-msdt:, custom OS handlers)
  // is rejected.
  if (
    v.startsWith('https://') ||
    v.startsWith('http://') ||
    v.startsWith('mailto:') ||
    v.startsWith('tel:') ||
    v.startsWith('#')
  ) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('//');
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function sanitizeNode(node: Node, out: string[], state: { taskIndex: number }): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(escText(node.textContent ?? ''));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    // Comments / processing instructions: drop silently.
    return;
  }
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // Task lists only. marked (GFM) renders "- [ ]" / "- [x]" as a DISABLED
  // checkbox inside the <li> — that `disabled` is marked's signature, so
  // only a checkbox carrying it is a real task item. It comes back as a
  // LIVE checkbox: no `disabled` (a disabled box can't be clicked, which
  // is the whole point), plus a `data-task` index in document order so
  // the preview click handler can flip the matching source line. Only
  // `type`, `checked` and the generated `data-task` survive; every other
  // <input> stays dropped.
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type === 'checkbox' && el.hasAttribute('disabled')) {
      const idx = state.taskIndex++;
      out.push(`<input type="checkbox" data-task="${idx}"${el.hasAttribute('checked') ? ' checked' : ''}>`);
    }
    return;
  }

  if (DROPPED_TAGS.has(tag)) return; // drop element + contents

  if (!SAFE_TAGS.has(tag)) {
    // Unknown tag: escape its markup as text, keep its children as text.
    // No element is ever emitted for it.
    for (const child of Array.from(el.childNodes)) sanitizeNode(child, out, state);
    return;
  }

  const attrs: string[] = [];
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    if (href && isSafeUrl(href, 'href')) {
      attrs.push(`href="${escAttr(href)}"`);
    } else if (!href) {
      attrs.push('href="#"');
    }
    attrs.push('rel="noopener noreferrer"');
  } else if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    if (!src || !isSafeUrl(src, 'src')) return; // drop remote/unsafe image
    attrs.push(`src="${escAttr(src)}"`);
    const alt = el.getAttribute('alt');
    if (alt !== null) attrs.push(`alt="${escAttr(alt)}"`);
    const title = el.getAttribute('title');
    if (title !== null) attrs.push(`title="${escAttr(title)}"`);
  }
  // No other tag keeps any attribute (no style, no on*, no colspan tricks).

  const voidTag = tag === 'br' || tag === 'hr' || tag === 'img';
  out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
  for (const child of Array.from(el.childNodes)) sanitizeNode(child, out, state);
  if (!voidTag) out.push(`</${tag}>`);
}

/**
 * Sanitize markdown-compiled HTML for safe innerHTML preview rendering.
 *
 * Intended usage in Editor.tsx:
 *   const renderedHtml = sanitizeMarkdownHtml(
 *     marked.parse(content || '*No content yet*', { async: false }) as string
 *   );
 * Returns '' for non-string / empty inputs or on any failure.
 */
export function sanitizeMarkdownHtml(html: string): string {
  if (typeof html !== 'string' || !html) return html || '';
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const body = doc.body;
    if (!body) return '';
    const out: string[] = [];
    const state = { taskIndex: 0 };
    for (const child of Array.from(body.childNodes)) sanitizeNode(child, out, state);
    return out.join('');
  } catch {
    // On any unexpected failure, return a safe empty string rather than
    // passing unsanitized markup through to innerHTML.
    return '';
  }
}

// --- Clipboard helper ------------------------------------------------------

/**
 * Copy text to the clipboard. Prefers the async Clipboard API; on any
 * failure (permissions, insecure context, Tauri webview quirks) falls back
 * to the classic hidden-textarea + execCommand('copy') path.
 * Returns true on success, false when both paths fail.
 */
export async function safeClipboardCopy(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('clipboard unavailable');
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
