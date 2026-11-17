use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use chrono::{Local, TimeZone};
use rand::Rng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    #[serde(rename = "fileName")]
    file_name: String,
    folder: String,
    content: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "modifiedAt")]
    modified_at: String,
    #[serde(default)]
    pinned: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FolderInfo {
    name: String,
    count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    theme: String,
    /// Folio palette id (see src/lib/themes.ts). The liquid-glass
    /// intensity (0-100, default 70) drives the frosted look.
    #[serde(default = "default_palette")]
    palette: String,
    #[serde(default = "default_zoom")]
    zoom: u32,
    /// Editor font family — 'system' | 'serif' | 'mono'.
    #[serde(rename = "editorFontFamily", default = "default_editor_font_family")]
    editor_font_family: String,
    /// Bold interface text. The note text itself is never bolded by this.
    #[serde(rename = "uiBold", default)]
    ui_bold: bool,
    #[serde(rename = "spellCheck", default = "default_spell_check")]
    spell_check: bool,
    #[serde(rename = "lineNumbers", default)]
    line_numbers: bool,
    /// Liquid-glass intensity (0-100). Settings files without this field
    /// still parse, using the default.
    #[serde(default = "default_glassiness")]
    glassiness: u32,
    /// Editor text size in px (12-26). Settings files without this field
    /// parse with 14.
    #[serde(rename = "editorFontSize", default = "default_editor_font_size")]
    editor_font_size: u32,
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_palette() -> String {
    "forest".to_string()
}

fn default_zoom() -> u32 {
    100
}

fn default_spell_check() -> bool {
    true
}

fn default_glassiness() -> u32 {
    70
}

fn default_editor_font_size() -> u32 {
    14
}

fn default_editor_font_family() -> String {
    "system".to_string()
}

/// The factory defaults, in one place.
///
/// The per-field `#[serde(default = "...")]` helpers above and this impl
/// must agree, otherwise a settings.json written by the app and a missing
/// settings.json would produce two different "default" states. A single
/// `Default` also means a new field can never break a struct literal.
impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            theme: default_theme(),
            palette: default_palette(),
            zoom: default_zoom(),
            editor_font_family: default_editor_font_family(),
            ui_bold: false,
            spell_check: default_spell_check(),
            line_numbers: false,
            glassiness: default_glassiness(),
            editor_font_size: default_editor_font_size(),
        }
    }
}

/// Cap on note content accepted over IPC (album-of-text sanity bound).
/// 4MB is far beyond any real note yet stops a runaway render loop from
/// filling disk via All Notes.txt rewrites.
const MAX_CONTENT_BYTES: usize = 4 * 1024 * 1024;

/// Folio palette ids (kept in sync with PALETTE_IDS in src/lib/storage.ts).
const PALETTE_IDS: &[&str] = &[
    "forest", "ember", "sage", "lagoon", "ultraviolet", "indigo", "graphite",
    "violet", "bronze", "teal", "mist", "lavender", "royal", "tangerine",
    "amethyst", "rose",
];

/// Hardened settings validation — reject out-of-range / unknown values that
/// a hand-edited or corrupted settings.json could carry. Clamps instead of
/// trusting the raw numbers so a bad file can never push the UI off-screen.
/// The palette is allowlisted (matching the frontend); an unknown id falls
/// back to Forest instead of passing through and silently breaking theme
/// derivation.
fn sanitize_settings(mut s: AppSettings) -> AppSettings {
    if s.theme != "dark" && s.theme != "light" {
        s.theme = "dark".to_string();
    }
    if !PALETTE_IDS.contains(&s.palette.as_str()) {
        s.palette = "forest".to_string();
    }
    s.zoom = s.zoom.clamp(90, 150);
    s.glassiness = s.glassiness.min(100);
    s.editor_font_size = s.editor_font_size.clamp(12, 26);
    // The font family is allowlisted; an unknown value falls back to 'system'.
    if s.editor_font_family != "system"
        && s.editor_font_family != "serif"
        && s.editor_font_family != "mono"
    {
        s.editor_font_family = "system".to_string();
    }
    s
}

// ---------------------------------------------------------------------------
// Process-wide locks: registry read-modify-writes and backup rewrites are
// serialized so concurrent Tauri commands cannot interleave and lose each
// other's updates, nor corrupt a shared temp file.
// ---------------------------------------------------------------------------

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
static BACKUP_LOCK: Mutex<()> = Mutex::new(());

fn lock_registry() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn lock_backup() -> std::sync::MutexGuard<'static, ()> {
    BACKUP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// Pins — persisted next to the exe in pins.json, so the Rust side is the
// source of truth for the pinned flag.
// ---------------------------------------------------------------------------

fn pins_path() -> PathBuf {
    get_app_dir().join("pins.json")
}

fn read_pins() -> HashSet<String> {
    let path = pins_path();
    if let Some(data) = read_registry_file(&path) {
        if let Ok(names) = serde_json::from_str::<Vec<String>>(&data) {
            return names.into_iter().filter(|n| is_safe_bare_md_name(n)).collect();
        }
        // Salvage: one bad entry must not wipe every pin — keep the
        // entries that still parse instead of returning empty (the next
        // pin write would then overwrite the file and lose them all).
        if let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(&data) {
            return values
                .into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .filter(|n| is_safe_bare_md_name(n))
                .collect();
        }
    }
    HashSet::new()
}

fn write_pins(pins: &HashSet<String>) -> Result<(), String> {
    let mut names: Vec<String> = pins.iter().cloned().collect();
    names.sort();
    let json = serde_json::to_string_pretty(&names).map_err(|e| e.to_string())?;
    atomic_write_file(&pins_path(), &json)
}

/// When a note is renamed by a collision suffix (move_notes, or the
/// keep-notes path of delete_folder), its pin must follow it: pins are
/// keyed by bare file name, so a pin left on the old name would silently
/// attach to a different note that still carries that name.
fn transfer_pin(old_name: &str, new_name: &str) {
    if old_name == new_name {
        return;
    }
    let mut pins = read_pins();
    if pins.remove(old_name) {
        pins.insert(new_name.to_string());
        let _ = write_pins(&pins);
    }
}

/// Trashed notes remember their original folder in trash.json. A folder
/// rename must rewrite those records too, or restoring a note resurrects
/// the old folder name instead of landing in the renamed one.
fn rename_trash_folder(old_name: &str, new_name: &str) {
    let mut reg = read_trash_registry();
    let mut changed = false;
    for entry in reg.iter_mut() {
        if entry.1 == old_name {
            entry.1 = new_name.to_string();
            changed = true;
        }
    }
    if changed {
        let _ = write_trash_registry(&reg);
    }
}

/// Is-notes-universe check: a bare .md name may only be pinned if it exists
/// on disk (Notes/ or Trash/), preventing an unbounded pins.json.
fn note_exists_anywhere(file_name: &str) -> bool {
    if !is_safe_bare_md_name(file_name) {
        return false;
    }
    find_note_path(file_name).is_some() || trash_dir().join(file_name).is_file()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RestoreResult {
    #[serde(rename = "restoredCount")]
    restored_count: usize,
    message: String,
}

// The root directory where the exe is located. Tests (and only tests)
// may override it via FOLIO_APP_DIR so the suite never touches real user
// data. The override is honored in debug builds only: a release exe must
// never be redirected by a stray environment variable, or a user's notes
// would appear to vanish.
fn get_app_dir() -> PathBuf {
    if cfg!(debug_assertions) && std::env::var_os("FOLIO_APP_DIR").is_some() {
        if let Ok(dir) = std::env::var("FOLIO_APP_DIR") {
            if !dir.trim().is_empty() {
                return PathBuf::from(dir);
            }
        }
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            return parent.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

// The Notes/ folder path.
fn get_notes_dir() -> PathBuf {
    let dir = get_app_dir().join("Notes");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Best-effort fsync of the containing directory so a crash right after the
/// rename cannot lose the directory entry on filesystems that need it.
fn sync_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
}

// Read a small JSON registry file (pins.json, folders.json, trash.json)
// lossily: one invalid byte must not discard the whole file. A strict
// read would fail on that byte and return the empty default, and the next
// write of that registry would then overwrite the file and lose every
// entry it held.
fn read_registry_file(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

// Atomic file write (temp file + rename) that guarantees the parent
// directory exists first. A plain fs::write fails outright when the parent
// dir is missing; this creates it and reports the full path in the error, so
// a failure can actually be diagnosed from the UI.
//
// The temp name carries random hex so it is unpredictable, the file is
// created with create_new (never following/truncating a planted symlink),
// fsynced before rename, and unlinked on any error path so a failed write
// never litters .tmp-* files in Notes/.
fn atomic_write_file(path: &Path, content: &str) -> Result<(), String> {
    // An empty parent means "the current directory". create_dir_all("")
    // fails with a confusing ENOENT, so it is skipped.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create folder {}: {}", parent.display(), e))?;
        }
    }
    let mut rng = rand::thread_rng();
    let tmp_name = format!(
        ".tmp-{}-{:x}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        rng.gen::<u64>()
    );
    let mut tmp = path.to_path_buf();
    tmp.set_file_name(tmp_name);
    // Drop guard: remove the temp file unless the write committed.
    struct TempCleanup(PathBuf, bool);
    impl Drop for TempCleanup {
        fn drop(&mut self) {
            if !self.1 {
                let _ = fs::remove_file(&self.0);
            }
        }
    }
    let mut guard = TempCleanup(tmp.clone(), false);
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
        f.sync_all()
            .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
    }
    fs::rename(&tmp, path)
        .map_err(|e| format!("cannot move {} to {}: {}", tmp.display(), path.display(), e))?;
    sync_parent_dir(path);
    guard.1 = true;
    Ok(())
}

// Windows reserved device names: checked with or without any extension.
fn is_reserved_device_name(base: &str) -> bool {
    matches!(
        base.to_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7"
            | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

// Validate + clean a folder name (Windows-safe).
// Returns None when the name is unusable — including a whitespace-only
// name (" "), which has no forbidden characters but Windows refuses to make
// a spaces-only directory.
fn clean_folder_name(raw: &str) -> Option<String> {
    // Strip forbidden Windows chars, then trim whitespace.
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return None;
    }
    // Path components can never contain dots once separators are stripped,
    // but a bare ".." or "." must never survive as a folder name.
    if cleaned == "." || cleaned == ".." {
        return None;
    }
    // Reject control chars (Rust allows them; Windows does not).
    if cleaned.chars().any(|c| c.is_control()) {
        return None;
    }
    // Windows forbids names ending in a dot. (A trailing space is already
    // gone: the name was trimmed above.)
    if cleaned.ends_with('.') {
        return None;
    }
    // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
    // with or without an extension.
    let base = cleaned.split('.').next().unwrap_or("");
    if is_reserved_device_name(base) {
        return None;
    }
    // Bound the name so absurd IPC payloads cannot create pathologically
    // long paths (NTFS component limit is 255 UTF-16 code units).
    if cleaned.chars().count() > 100 {
        return None;
    }
    Some(cleaned)
}

/// Resolve a folder argument to a directory guaranteed to be a direct
/// child of Notes/. Every command that takes a folder routes through here —
/// never join a raw IPC string onto Notes/. Empty means root.
/// Errors on invalid input instead of silently cleaning it away.
fn resolve_folder_dir(folder: &str) -> Result<PathBuf, String> {
    let notes_dir = get_notes_dir();
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return Ok(notes_dir);
    }
    // "Root" is the backup-file label for the empty folder; reject it as a
    // real name so a crafted backup cannot shadow it. clean_folder_name
    // alone would accept it, so the check has to live here.
    if trimmed.eq_ignore_ascii_case("root") {
        return Err("Invalid folder name".to_string());
    }
    let clean = clean_folder_name(folder)
        .ok_or_else(|| "Invalid folder name".to_string())?;
    let dir = notes_dir.join(&clean);
    // A symlinked folder must never be written through: the collectors
    // refuse to follow symlinks, so a note created here would be invisible
    // to get_notes yet live outside Notes/.
    if dir.exists() && is_symlink_path(&dir) {
        return Err("Invalid folder name".to_string());
    }
    // Defense in depth: canonicalize both sides so the Windows `\\\\?\\`
    // prefix canonicalize() adds cannot make a legitimate child fail the
    // containment check. If the child does not exist yet, build its
    // canonical path from the (canonicalized) Notes/ dir + the validated
    // name instead of falling back to a non-prefixed path.
    let notes_canon = notes_dir
        .canonicalize()
        .unwrap_or_else(|_| notes_dir.clone());
    let dir_canon = if dir.exists() {
        dir.canonicalize().unwrap_or_else(|_| dir.clone())
    } else {
        notes_canon.join(&clean)
    };
    if !dir_canon.starts_with(&notes_canon) {
        return Err("Invalid folder name".to_string());
    }
    Ok(dir)
}

/// True when the path is a symlink or junction (Windows junctions report
/// as symlinks through symlink_metadata).
fn is_symlink_path(path: &Path) -> bool {
    path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Case-insensitive ".md" check: NTFS is case-insensitive, so NOTE.MD must
/// be visible to the same code paths as note.md.
fn has_md_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

// Folder registry: a `folders.json` file next to the exe (same mechanism as
// `settings.json`). This is the source of truth for which folders exist.
//
// Registering a folder is a plain file write next to the exe, so the folder
// appears in the UI and persists even when directory creation fails; the
// directory is created opportunistically.
fn folders_registry_path() -> PathBuf {
    get_app_dir().join("folders.json")
}

fn read_folders_registry() -> Vec<String> {
    let path = folders_registry_path();
    if let Some(data) = read_registry_file(&path) {
        if let Ok(names) = serde_json::from_str::<Vec<String>>(&data) {
            return names;
        }
        // Salvage: one bad entry must not wipe every folder — keep the
        // entries that still parse (the next registry write would
        // otherwise overwrite the file and lose them all).
        if let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(&data) {
            return values
                .into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
        }
    }
    Vec::new()
}

fn write_folders_registry(names: &[String]) -> Result<(), String> {
    let path = folders_registry_path();
    let json = serde_json::to_string_pretty(&names).map_err(|e| e.to_string())?;
    atomic_write_file(&path, &json)
}

/// Validate a bare *.md file name: reject slashes, subpaths and non-md
/// names. Also rejects NTFS ADS colons, Windows device names, control
/// chars, trailing dots/spaces, and over-long names. The frontend's
/// generateNoteFileName enforces these as well; the backend enforces them
/// independently.
///
/// A ".." *inside* the name is allowed. The name is used as ONE path
/// component (Notes/<name>), so it cannot traverse anywhere; the real
/// traversal vectors are the separators, the NTFS ADS colon and a bare
/// "." / ".." component — and the stem checks below reject a stem that is
/// only dots ("..md" -> stem "." is rejected). The generator
/// (generate_safe_file_name) never emits a dot in the slug, so new notes
/// never contain one at all.
fn is_safe_bare_md_name(name: &str) -> bool {
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".md") {
        return false;
    }
    if name.len() > 200 {
        return false;
    }
    if name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || name.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*') || c.is_control())
    {
        return false;
    }
    // No leading/trailing dot or space, and no bare ".md".
    let stem = &name[..name.len() - 3];
    if stem.is_empty() || stem.starts_with('.') || stem.ends_with('.') || stem.ends_with(' ') {
        return false;
    }
    if stem == ".." {
        return false;
    }
    // Windows reserves CON, PRN, AUX, NUL, COM1-9, LPT1-9 with or without
    // an extension — "CON.foo.md" is reserved just like "CON.md".
    if is_reserved_device_name(stem.split('.').next().unwrap_or("")) {
        return false;
    }
    true
}

/// The file name without its ".md" extension, matched CASE-INSENSITIVELY.
///
/// NTFS is case-insensitive, so "NOTE.MD" is the same file as "note.md",
/// while `str::strip_suffix(".md")` is case-sensitive. Every name-building
/// site goes through this helper.
///
/// The slice is safe: the last three bytes are the ASCII ".md", so
/// `len() - 3` is always a character boundary.
fn md_stem(file_name: &str) -> &str {
    if let Some(stem) = file_name.strip_suffix(".md") {
        return stem;
    }
    let bytes = file_name.as_bytes();
    if bytes.len() >= 3
        && bytes[bytes.len() - 3].eq_ignore_ascii_case(&b'.')
        && bytes[bytes.len() - 2].eq_ignore_ascii_case(&b'm')
        && bytes[bytes.len() - 1].eq_ignore_ascii_case(&b'd')
    {
        return &file_name[..file_name.len() - 3];
    }
    file_name
}

/// Longest char-boundary prefix of `stem` such that `prefix + suffix` is
/// at most 200 bytes — the cap is_safe_bare_md_name() enforces. A suffixed
/// rename (move / trash / dedupe) of a near-limit hand-placed name must
/// never produce a name save_note() refuses, stranding the note read-only
/// (or, for trash, unrestorable).
fn stem_fitting(stem: &str, suffix: &str) -> String {
    let mut out = String::new();
    for c in stem.chars() {
        if out.len() + c.len_utf8() + suffix.len() > 200 {
            break;
        }
        out.push(c);
    }
    out
}

// Scan Notes/ (root + 1-level subfolders) WITHOUT touching the backup.
// The backup is rewritten only by mutations (via rewrite_backup()), never on
// reads, and every mutation calls collect_notes() once and rewrites exactly
// once.
//
// Note reads are lossy: a .md file with invalid UTF-8 (or one that cannot
// be read) must not come back as an EMPTY string, or the note would show as
// blank and a later save would silently destroy the original bytes. Reading
// bytes and decoding lossily preserves everything readable (invalid
// sequences become U+FFFD) instead of vanishing the whole note.
fn read_note_content(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    }
}

/// The date + time encoded in a generated note file name:
/// "YYYY-MM-DD_HH-MM-SS_slug_hex.md" → (year, month, day, hour, minute, second).
///
/// The file's own creation time is NOT a reliable "created at" —
/// every save replaces the file (atomic temp-file + rename), and on Windows
/// the replacement inherits the *temp* file's creation time. An edited note
/// would be re-dated and jump to the top of the default "Created" sort, so
/// the name prefix is the source of truth; the filesystem creation time is
/// only a fallback for names without a prefix.
fn parse_name_timestamp(file_name: &str) -> Option<(i32, u32, u32, u32, u32, u32)> {
    let prefix = file_name.get(..19)?; // "YYYY-MM-DD_HH-MM-SS"
    let (date_part, time_part) = prefix.split_once('_')?;
    let mut d = date_part.split('-');
    let year: i32 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    if d.next().is_some() {
        return None;
    }
    let mut t = time_part.split('-');
    let hour: u32 = t.next()?.parse().ok()?;
    let minute: u32 = t.next()?.parse().ok()?;
    let second: u32 = t.next()?.parse().ok()?;
    if t.next().is_some() {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some((year, month, day, hour, minute, second))
}

/// The creation time encoded in a generated note file name, as RFC3339.
fn created_at_from_name(file_name: &str) -> Option<String> {
    let (year, month, day, hour, minute, second) = parse_name_timestamp(file_name)?;
    let naive = chrono::NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, second)?;
    let local = chrono::Local.from_local_datetime(&naive).earliest()?;
    Some(local.to_rfc3339())
}

// Build one Note from a .md file on disk. The caller has already checked
// the path is a real (non-symlink) file with a .md extension.
fn note_from_path(
    path: &Path,
    file_name: &str,
    folder: String,
    metadata: Option<fs::Metadata>,
    pins: &HashSet<String>,
) -> Note {
    let content = read_note_content(path);
    // The name prefix is the stable creation time (see
    // created_at_from_name); the filesystem timestamp is only a fallback
    // for files renamed by hand.
    let created = created_at_from_name(file_name)
        .or_else(|| {
            metadata
                .as_ref()
                .and_then(|m| m.created().ok())
                .map(|t| chrono::DateTime::<Local>::from(t).to_rfc3339())
        })
        .unwrap_or_else(|| Local::now().to_rfc3339());
    let modified = metadata
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<Local>::from(t).to_rfc3339())
        .unwrap_or_else(|| Local::now().to_rfc3339());
    Note {
        file_name: file_name.to_string(),
        folder,
        content,
        created_at: created,
        modified_at: modified,
        pinned: pins.contains(file_name),
    }
}

// Symlinks are never followed: a symlinked .md or folder is skipped, so a
// planted link can neither be read nor deleted through.
fn collect_notes() -> Vec<Note> {
    let notes_dir = get_notes_dir();
    let pins = read_pins();
    let mut notes = Vec::new();

    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_file() && has_md_extension(&path) {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    let metadata = entry.metadata().ok();
                    notes.push(note_from_path(
                        &path,
                        file_name,
                        String::new(),
                        metadata,
                        &pins,
                    ));
                }
            } else if path.is_dir() {
                let folder_name = entry.file_name().to_string_lossy().to_string();
                if let Ok(sub_entries) = fs::read_dir(&path) {
                    for sub in sub_entries.flatten() {
                        let sub_path = sub.path();
                        if is_symlink_path(&sub_path) {
                            continue;
                        }
                        if sub_path.is_file() && has_md_extension(&sub_path) {
                            if let Some(file_name) = sub_path.file_name().and_then(|n| n.to_str()) {
                                let metadata = sub.metadata().ok();
                                notes.push(note_from_path(
                                    &sub_path,
                                    file_name,
                                    folder_name.clone(),
                                    metadata,
                                    &pins,
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    // Deterministic order (newest-created first) instead of raw readdir
    // order, so the default selected note and any list assumptions are stable.
    // Each timestamp is parsed once here, not once per comparison: parsing
    // inside the comparator re-parsed every timestamp O(log n) times, and
    // the old fallback (a fresh Local::now() per comparison) could return
    // a different instant for the same note on each call, so the ordering
    // was not even consistent within one sort. One fallback instant is
    // computed up front and shared instead.
    let fallback = Local::now();
    let mut keyed: Vec<(chrono::DateTime<Local>, Note)> = notes
        .into_iter()
        .map(|n| {
            let key = chrono::DateTime::parse_from_rfc3339(&n.created_at)
                .map(|d| d.with_timezone(&Local))
                .unwrap_or(fallback);
            (key, n)
        })
        .collect();
    keyed.sort_by(|a, b| b.0.cmp(&a.0));
    keyed.into_iter().map(|(_, n)| n).collect()
}

/// The bare names of every .md file in Notes/ (root + 1 level of
/// sub-folders), WITHOUT reading their contents.
///
/// Used by restore_backup() to answer "does this name already exist?"
/// without re-scanning the tree for every single backup entry. The names
/// are lower-cased: the filesystem is case-insensitive on Windows, so
/// "NOTE.MD" and "note.md" are the same note.
fn list_note_names() -> HashSet<String> {
    let mut names = HashSet::new();
    let notes_dir = get_notes_dir();
    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_file() && has_md_extension(&path) {
                if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                    names.insert(n.to_lowercase());
                }
            } else if path.is_dir() {
                if let Ok(subs) = fs::read_dir(&path) {
                    for sub in subs.flatten() {
                        let sub_path = sub.path();
                        if is_symlink_path(&sub_path) {
                            continue;
                        }
                        if sub_path.is_file() && has_md_extension(&sub_path) {
                            if let Some(n) = sub_path.file_name().and_then(|n| n.to_str()) {
                                names.insert(n.to_lowercase());
                            }
                        }
                    }
                }
            }
        }
    }
    names
}

/// The bare names of every .md file in Trash/ (lower-cased).
///
/// A restore must never resurrect a note the user deliberately trashed.
fn list_trash_names() -> HashSet<String> {
    let mut names = HashSet::new();
    if let Ok(entries) = fs::read_dir(trash_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_file() && has_md_extension(&path) {
                if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                    names.insert(n.to_lowercase());
                }
            }
        }
    }
    names
}

/// Lower-cased bare names of every .md note living anywhere in Notes/
/// EXCEPT inside `except_dir`, which must be a direct child of Notes/
/// (root + every other subfolder).
///
/// Deleting a folder with "keep the notes" moves its notes to the root,
/// and notes are identified by bare name across the whole tree: a name
/// that is free in the root can still be taken by a note in another
/// folder, and moving onto it would leave two notes the UI cannot tell
/// apart. A check of the destination directory alone cannot see that;
/// this set can.
fn note_names_except(except_dir: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    let notes_dir = get_notes_dir();
    // The folder itself, matched by name case-insensitively: the
    // filesystem is case-insensitive on Windows, so "Work" and "work"
    // are the same directory and its own notes must not count as taken.
    let except_name = except_dir
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase());
    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_file() && has_md_extension(&path) {
                if let Some(n) = path.file_name().and_then(|n| n.to_str()) {
                    names.insert(n.to_lowercase());
                }
            } else if path.is_dir() {
                let dir_name = entry.file_name().to_string_lossy().to_lowercase();
                if Some(dir_name.as_str()) == except_name.as_deref() {
                    continue;
                }
                if let Ok(subs) = fs::read_dir(&path) {
                    for sub in subs.flatten() {
                        let sub_path = sub.path();
                        if is_symlink_path(&sub_path) {
                            continue;
                        }
                        if sub_path.is_file() && has_md_extension(&sub_path) {
                            if let Some(n) = sub_path.file_name().and_then(|n| n.to_str()) {
                                names.insert(n.to_lowercase());
                            }
                        }
                    }
                }
            }
        }
    }
    names
}

// Rewrite the backup from a freshly collected scan (single scan + write).
// Serialized by BACKUP_LOCK so overlapping mutations cannot interleave
// temp-file/rename steps on the same backup.
fn rewrite_backup() {
    let _guard = lock_backup();
    if let Err(e) = rewrite_backup_atomic(&collect_notes()) {
        // The note itself is already written — a stale backup must never
        // fail the save, but it is worth knowing about (e.g. the backup
        // file is open in another program and cannot be replaced).
        eprintln!("could not rewrite All Notes.txt: {}", e);
    }
}

// Atomic write for All Notes.txt, serialized by BACKUP_LOCK (see
// rewrite_backup). The bytes are built here and written through the shared
// atomic writer (temp file + fsync + rename + parent-dir fsync), so the
// backup has exactly one temp-file implementation to keep correct.
fn rewrite_backup_atomic(notes: &[Note]) -> Result<(), String> {
    let backup_path = get_app_dir().join("All Notes.txt");
    // Keep one previous generation: if the newest backup is ever lost,
    // corrupted, or deleted by accident, the restore can fall back to
    // `All Notes.previous.txt` instead of having no backup at all.
    // Best-effort only — a failed rotation must never fail the backup.
    if backup_path.exists() {
        let prev_path = get_app_dir().join("All Notes.previous.txt");
        let _ = fs::copy(&backup_path, &prev_path);
    }

    let divider = "=".repeat(80);
    let mut output = String::new();
    output.push_str("# FOLIO BACKUP - ATOMIC ALL NOTES\n");
    output.push_str(&format!("# Total Notes: {}\n", notes.len()));
    output.push_str(&format!("# Exported At: {}\n", Local::now().to_rfc3339()));
    output.push_str("# Format: Plain Markdown with dividers\n\n");

    for note in notes {
        let folder_label = if note.folder.is_empty() { "Root" } else { &note.folder };
        output.push_str(&format!("{}\n", divider));
        output.push_str(&format!(
            "FILE: {} | FOLDER: {} | CREATED: {} | MODIFIED: {}\n",
            note.file_name, folder_label, note.created_at, note.modified_at
        ));
        output.push_str(&format!("{}\n\n{}\n\n", divider, note.content));
    }

    atomic_write_file(&backup_path, &output)
}

/// Parse a backup into (header line, raw body) entries by matching complete
/// `divider + FILE: header + divider` triplets.
///
/// A bare divider line inside a body is just body text — only a divider
/// that is immediately followed by a FILE: header line and another divider
/// starts a new entry. The frontend parser (utils.ts) matches the same
/// triplets, so both sides agree on what a backup contains.
fn parse_backup_entries(content: &str) -> Vec<(&str, &str)> {
    // (line text without terminator, byte range of the whole line incl. \n)
    let mut lines: Vec<(&str, usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    for line in content.split_inclusive('\n') {
        let start = cursor;
        let end = cursor + line.len();
        let text = line.trim_end_matches(['\r', '\n']);
        lines.push((text, start, end));
        cursor = end;
    }
    let is_divider = |text: &str| text.len() >= 40 && text.bytes().all(|b| b == b'=');
    let is_header = |text: &str| {
        text.trim_start()
            .get(..5)
            .map(|p| p.eq_ignore_ascii_case("file:"))
            .unwrap_or(false)
    };

    // Byte offset where each entry starts (its first divider line).
    let mut starts: Vec<usize> = Vec::new();
    let mut i = 0usize;
    while i + 2 < lines.len() {
        let (text, start, _) = lines[i];
        let (next, _, _) = lines[i + 1];
        let (after, _, _) = lines[i + 2];
        if is_divider(text) && is_header(next) && is_divider(after) {
            starts.push(start);
            // Skip past the triplet; the body runs until the next entry.
            i += 3;
        } else {
            i += 1;
        }
    }

    // Byte offset -> line number, built once: looking each entry's header
    // up by scanning all lines from the start is O(entries x lines),
    // which dominates restore time on a large backup.
    let mut line_by_start: HashMap<usize, usize> = HashMap::with_capacity(lines.len());
    for (idx, &(_, start, _)) in lines.iter().enumerate() {
        line_by_start.insert(start, idx);
    }

    let mut entries: Vec<(&str, &str)> = Vec::new();
    for (idx, &start) in starts.iter().enumerate() {
        // Header line = the line right after this entry's first divider.
        let header_idx = line_by_start
            .get(&start)
            .copied()
            .map(|p| p + 1)
            .unwrap_or(0);
        let header = lines.get(header_idx).map(|&(t, _, _)| t).unwrap_or("");
        // Body starts after the second divider line.
        let body_start = lines.get(header_idx + 1).map(|&(_, _, e)| e).unwrap_or(content.len());
        let body_end = starts
            .get(idx + 1)
            .copied()
            .unwrap_or(content.len());
        entries.push((header, &content[body_start..body_end]));
    }
    entries
}

/// Strip exactly the framing the backup writer puts around each note body:
/// ONE leading newline (the blank line that follows the divider) and TWO
/// trailing newlines (the one that terminates the content's last line plus
/// the blank line that separates the note from the next divider).
///
/// The writer emits `divider\n\n{content}\n\n`, so the section that lands
/// between two dividers is exactly `\n{content}\n\n`.
///
/// The framing is removed by count and not by trimming, so the
/// leading/trailing blank lines that belong to the NOTE itself survive.
fn strip_backup_framing(section: &str) -> &str {
    // Leading: exactly one newline ("\n" or "\r\n").
    let mut out = section;
    if let Some(rest) = out.strip_prefix("\r\n") {
        out = rest;
    } else if let Some(rest) = out.strip_prefix('\n') {
        out = rest;
    }
    // Trailing: exactly two newlines.
    for _ in 0..2 {
        if let Some(rest) = out.strip_suffix("\r\n") {
            out = rest;
        } else if let Some(rest) = out.strip_suffix('\n') {
            out = rest;
        } else {
            break;
        }
    }
    out
}

// Find an existing note path across Notes/ root and subfolders.
// Root wins deterministically (read_dir order is unspecified).
// Symlinked folders/files are never followed.
fn find_note_path(file_name: &str) -> Option<(PathBuf, String)> {
    if !is_safe_bare_md_name(file_name) {
        return None;
    }
    let notes_dir = get_notes_dir();

    // Check root
    let root_path = notes_dir.join(file_name);
    if root_path.is_file() && !is_symlink_path(&root_path) {
        return Some((root_path, String::new()));
    }

    // Check subfolders
    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_dir() {
                let candidate = path.join(file_name);
                if candidate.is_file() && !is_symlink_path(&candidate) {
                    let folder_name = entry.file_name().to_string_lossy().to_string();
                    return Some((candidate, folder_name));
                }
            }
        }
    }
    None
}

/// Lowest free bare name near `base`: base itself, then base_2, base_3, ...
/// Scans root + subfolders so a name already used anywhere is never reused
/// for a different note.
fn unique_bare_name(base: &str) -> String {
    if find_note_path(base).is_none() {
        return base.to_string();
    }
    let stem = md_stem(base);
    let mut n = 2u32;
    loop {
        let suffix = format!("_{}.md", n);
        let candidate = format!("{}{}", stem_fitting(stem, &suffix), suffix);
        if find_note_path(&candidate).is_none() {
            return candidate;
        }
        if n == u32::MAX {
            // Never spin forever if the counter ever wrapped: fall back
            // to a random suffix instead of handing back a taken name.
            let mut rng = rand::thread_rng();
            let suffix = format!("_{}_{}.md", n, rng.gen::<u64>());
            return format!("{}{}", stem_fitting(stem, &suffix), suffix);
        }
        n += 1;
    }
}

// Generate a unique Persian/Arabic/Unicode safe file name.
// The random suffix is u32 (4 billion values); create_note enforces
// global uniqueness via unique_bare_name(), so even an (astronomically
// unlikely) same-second collision suffixes instead of overwriting.
//
// The slug is built by slug_from_content(): forbidden Windows characters
// become spaces and DOTS become word separators, so a name never contains
// a ".." that the name validator would reject.
fn generate_safe_file_name(content: &str) -> String {
    let now = Local::now();
    let date_prefix = now.format("%Y-%m-%d_%H-%M-%S").to_string();
    let truncated_slug = slug_from_content(content);

    let mut rng = rand::thread_rng();
    let hex: u32 = rng.gen();

    let candidate = if truncated_slug.is_empty() {
        format!("{}_note_{:08x}.md", date_prefix, hex)
    } else {
        format!("{}_{}_{:08x}.md", date_prefix, truncated_slug, hex)
    };

    // SAFETY NET: the name must pass the very validator save_note() uses.
    // A note whose name the backend refuses to save is listed in the UI but
    // can never be written to disk again — the text is silently lost on
    // every edit. The generator therefore PROVES the name is saveable
    // instead of trusting the slug rules to have thought of everything. The
    // fallback keeps the timestamp and the random suffix, so it is just as
    // unique.
    if is_safe_bare_md_name(&candidate) {
        candidate
    } else {
        format!("{}_note_{:08x}.md", date_prefix, hex)
    }
}

/// The file-name slug for a note: the first non-empty line, with the
/// characters Windows forbids in a path (<>:"/\|?*) AND the control
/// characters replaced by a space, dots turned into word separators, words
/// joined by '-', truncated to 36 characters.
///
/// The forbidden characters are REPLACED (not removed) so the words stay
/// separate and the Rust generator agrees with the TypeScript one
/// (utils.ts). A control character is not whitespace, so it must be
/// replaced too — is_safe_bare_md_name() rejects control characters, and a
/// name carrying one could never be saved.
fn slug_from_content(content: &str) -> String {
    let first_line = content.lines().map(|s| s.trim()).find(|s| !s.is_empty()).unwrap_or("");

    let clean: String = first_line
        .chars()
        .map(|c| {
            if c == '.' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();

    let words: Vec<&str> = clean.split_whitespace().collect();
    let slug = words.join("-");
    // Truncate on char boundaries (already) — chars() avoids splitting
    // surrogate pairs / grapheme clusters in UTF-16 terms.
    slug.chars().take(36).collect()
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

#[tauri::command]
fn get_notes() -> Result<Vec<Note>, String> {
    // Pure read. The backup is rewritten only by mutations (via
    // rewrite_backup()), never on reads.
    Ok(collect_notes())
}

#[tauri::command]
fn create_note(content: String, folder: String) -> Result<Note, String> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err("Note is too large to save.".to_string());
    }
    // Serialize with the other mutations (save/delete/move/restore all
    // hold this lock): two concurrent creates could otherwise interleave
    // file write + backup rewrite so the LAST backup written came from a
    // scan taken before the other note's file existed — a stale
    // All Notes.txt missing a live note. Lock order REGISTRY -> BACKUP
    // holds: rewrite_backup() below takes BACKUP_LOCK.
    let _guard = lock_registry();
    // The folder goes through the validated resolver — a traversal string
    // can never escape Notes/.
    let target_dir = resolve_folder_dir(&folder)?;
    // Canonical folder label echoed back so the UI agrees with disk.
    let canonical_folder = if target_dir == get_notes_dir() {
        String::new()
    } else {
        target_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    }

    // Never overwrite an existing note — suffix until globally unique.
    let file_name = unique_bare_name(&generate_safe_file_name(&content));
    let file_path = target_dir.join(&file_name);
    // atomic write (creates the parent dir if needed).
    atomic_write_file(&file_path, &content)?;

    // The creation time is the one encoded in the generated name, so the
    // note this call returns already agrees with what get_notes() reports
    // for it (which derives created_at from the name, second precision).
    let now = created_at_from_name(&file_name).unwrap_or_else(|| Local::now().to_rfc3339());
    let note = Note {
        file_name,
        folder: canonical_folder,
        content,
        created_at: now.clone(),
        modified_at: now,
        pinned: false,
    };

    rewrite_backup();

    Ok(note)
}

#[tauri::command]
fn save_note(file_name: String, content: String) -> Result<bool, String> {
    // Reject paths and non-md names, and ONLY update an existing note.
    if !is_safe_bare_md_name(&file_name) {
        return Err("Invalid note file name".to_string());
    }
    if content.len() > MAX_CONTENT_BYTES {
        return Err("Note is too large to save.".to_string());
    }

    // Hold the registry lock for the whole save. Sharing the lock with
    // delete_note() makes the two mutually exclusive, so a late autosave
    // cannot resurrect a note that was just deleted.
    //
    // Lock order is always REGISTRY -> BACKUP, so this cannot deadlock.
    let _guard = lock_registry();

    // If the file is not where find_note_path expects it, it is NOT saved.
    // Writing it to the root instead would resurrect a note that had just
    // been deleted (a late autosave racing the delete) — real data
    // corruption. Return an Err (not Ok(false)) so the frontend takes its
    // failure path, which parks the typed text in the localStorage mirror
    // instead of dropping it.
    let path = match find_note_path(&file_name) {
        Some((p, _)) => p,
        None => return Err("Note not found on disk.".to_string()),
    };

    // Atomic write (creates the parent dir if needed) with a detailed error
    // carrying the full path, so a failure shows exactly where and why it
    // failed instead of a bare OS error.
    atomic_write_file(&path, &content)?;

    rewrite_backup();

    Ok(true)
}

#[tauri::command]
fn delete_note(file_name: String) -> Result<bool, String> {
    // Deleting is a SOFT delete — the file moves to a Trash/ folder next to
    // the exe (with its original folder recorded in trash.json) instead of
    // being destroyed. Restore brings it back; "Delete forever"
    // (delete_note_permanent) is the only destroy.
    if !is_safe_bare_md_name(&file_name) {
        return Err("Invalid note file name".to_string());
    }
    let _guard = lock_registry();
    if let Some((path, folder)) = find_note_path(&file_name) {
        trash_one(&path, &file_name, &folder)?;
        rewrite_backup();
        return Ok(true);
    }
    Ok(false)
}

// ===========================================================================
// TRASH — soft delete with restore . Trashed .md files live in a
// top-level Trash/ folder next to the exe (NOT inside Notes/, so
// get_notes() never lists them). trash.json records each file's original
// folder + when it was trashed, so Restore puts it back where it was.
// ===========================================================================

fn trash_dir() -> PathBuf {
    let dir = get_app_dir().join("Trash");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn trash_registry_path() -> PathBuf {
    get_app_dir().join("trash.json")
}

/// (file_name, original_folder, trashed_at_iso)
fn read_trash_registry() -> Vec<(String, String, String)> {
    let path = trash_registry_path();
    if let Some(data) = read_registry_file(&path) {
        if let Ok(v) = serde_json::from_str::<Vec<(String, String, String)>>(&data) {
            return v;
        }
        // Salvage: one bad entry must not wipe every trashed note's folder
        // attribution — keep the entries that still parse (the next
        // registry write would otherwise overwrite the file and lose them).
        if let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(&data) {
            return values
                .into_iter()
                .filter_map(|v| {
                    let arr = v.as_array()?;
                    if arr.len() != 3 {
                        return None;
                    }
                    Some((
                        arr[0].as_str()?.to_string(),
                        arr[1].as_str()?.to_string(),
                        arr[2].as_str()?.to_string(),
                    ))
                })
                .collect();
        }
    }
    Vec::new()
}

fn write_trash_registry(entries: &[(String, String, String)]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    atomic_write_file(&trash_registry_path(), &json)
}

fn trash_one(path: &PathBuf, file_name: &str, folder: &str) -> Result<(), String> {
    // The registry write is atomic and the caller holds REGISTRY_LOCK, so
    // the read-modify-write cannot race another trash/restore.
    let dest = trash_dir().join(file_name);
    // Never overwrite a trashed file with the same name: suffix it with a
    // random hex so two deletes in the same second can never collide.
    let dest = if dest.exists() {
        // The name arrived via the case-insensitive check; keep the original
        // stem but build the suffix from it with the shared helper, so
        // "NOTE.MD" becomes "NOTE_12-00-00_abcd1234.md" (not "NOTE.MD_...").
        let stem = md_stem(file_name);
        let stamp = Local::now().format("%H-%M-%S").to_string();
        let mut rng = rand::thread_rng();
        let hex: u32 = rng.gen();
        let mut suffix = format!("_{}_{:08x}.md", stamp, hex);
        let mut candidate =
            trash_dir().join(format!("{}{}", stem_fitting(stem, &suffix), suffix));
        // Final guard: keep suffixing until the name is free.
        let mut n = 0u32;
        while candidate.exists() {
            n += 1;
            suffix = format!("_{}_{:08x}_{}.md", stamp, hex, n);
            candidate = trash_dir()
                .join(format!("{}{}", stem_fitting(stem, &suffix), suffix));
        }
        candidate
    } else {
        dest
    };
    fs::rename(path, &dest).map_err(|e| e.to_string())?;
    let mut reg = read_trash_registry();
    // Drop only a STALE entry for this bare name (one whose file is gone):
    // when the destination was suffixed because a trashed file with this
    // name already exists, that file's entry must survive — it still maps
    // the live trashed file to its original folder. Dropping every entry
    // for the name would leave the first trashed note with no folder to
    // restore to. When there was no collision the destination holds this
    // name, so any prior entry for it can only be stale (its file is
    // gone), and dropping it is what keeps the registry from going stale.
    reg.retain(|(f, _, _)| f != file_name || trash_dir().join(f).is_file());
    reg.push((
        dest.file_name().unwrap_or_default().to_string_lossy().to_string(),
        folder.to_string(),
        Local::now().to_rfc3339(),
    ));
    if let Err(e) = write_trash_registry(&reg) {
        // Roll back the rename so the note is not orphaned without a
        // registry entry.
        let _ = fs::rename(&dest, path);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
fn get_trash() -> Result<Vec<Note>, String> {
    let dir = trash_dir();
    let pins = read_pins();
    let mut notes = Vec::new();
    // Read the registry ONCE, not per entry.
    let reg = read_trash_registry();
    let mut earliest: HashMap<&str, &str> = HashMap::new();
    for (f, folder, _) in &reg {
        earliest.entry(f.as_str()).or_insert(folder.as_str());
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_file() && has_md_extension(&path) {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    let content = read_note_content(&path);
                    let metadata = entry.metadata().ok();
                    let modified = metadata
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .map(|t| chrono::DateTime::<Local>::from(t).to_rfc3339())
                        .unwrap_or_else(|| Local::now().to_rfc3339());
                    let folder = earliest.get(file_name).copied().unwrap_or_default();
                    let pinned = pins.contains(file_name);
                    notes.push(Note {
                        file_name: file_name.to_string(),
                        folder: folder.to_string(),
                        content,
                        created_at: modified.clone(),
                        modified_at: modified,
                        pinned,
                    });
                }
            }
        }
    }
    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(notes)
}

#[tauri::command]
fn restore_note(file_name: String) -> Result<bool, String> {
    if !is_safe_bare_md_name(&file_name) {
        return Err("Invalid note file name".to_string());
    }
    let _guard = lock_registry();
    let src = trash_dir().join(&file_name);
    if !src.is_file() || is_symlink_path(&src) {
        return Ok(false);
    }
    // Read once and reuse below: the lock is held throughout, so nothing
    // else can change the registry in between.
    let mut reg = read_trash_registry();
    let folder = reg
        .iter()
        .find(|(f, _, _)| f == &file_name)
        .map(|(_, folder, _)| folder.clone())
        .unwrap_or_default();
    // The recorded folder is hand-editable JSON — re-validate it. An
    // invalid folder name must not make the note unrestorable, so it lands
    // in the root folder instead: a note in the wrong place beats a note
    // that is lost.
    let dest_dir = resolve_folder_dir(&folder).unwrap_or_else(|_| get_notes_dir());
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    }
    // The check is global (root + every subfolder), not just the
    // destination folder: notes are identified by bare name, so restoring
    // a second "x.md" into another folder would leave two notes the UI
    // cannot tell apart — save/delete would hit the wrong one. On Windows
    // fs::rename overwrites, so the check also keeps a live note from
    // being destroyed by a restore.
    if find_note_path(&file_name).is_some() {
        return Err("A note with that name already exists.".to_string());
    }
    let dest = dest_dir.join(&file_name);
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    reg.retain(|(f, _, _)| f != &file_name);
    // The note IS restored at this point. A failed registry write must not
    // turn a successful restore into a reported failure (the UI would claim
    // "Restore Failed" for a note that is actually back). The stale entry
    // is harmless — get_trash lists the files on disk — and is cleaned by
    // the next successful registry write.
    if let Err(e) = write_trash_registry(&reg) {
        eprintln!("restore_note: could not update trash.json: {}", e);
    }
    rewrite_backup();
    Ok(true)
}

/// Drop a note's pin entry.
///
/// A note that no longer exists must not keep an entry in pins.json: the
/// file would grow without bound, and a new note reusing the name would
/// come up pinned for no reason.
///
/// The caller must hold REGISTRY_LOCK: every caller is a command that
/// already does.
fn unpin(file_name: &str) {
    let mut pins = read_pins();
    if pins.remove(file_name) {
        let _ = write_pins(&pins);
    }
}

/// Drop several pin entries with a single registry read + write. Deleting
/// a folder full of notes (or emptying the trash) unpins every note it
/// destroys; doing that one atomic registry rewrite per note is one
/// temp-file + fsync + rename cycle each, for no benefit.
///
/// Like unpin, the caller must hold REGISTRY_LOCK.
fn unpin_many(file_names: &[String]) {
    if file_names.is_empty() {
        return;
    }
    let mut pins = read_pins();
    let before = pins.len();
    for name in file_names {
        pins.remove(name);
    }
    if pins.len() != before {
        let _ = write_pins(&pins);
    }
}

#[tauri::command]
fn delete_note_permanent(file_name: String) -> Result<bool, String> {
    // The only destroy: removes the file from Trash/ for good.
    if !is_safe_bare_md_name(&file_name) {
        return Err("Invalid note file name".to_string());
    }
    let _guard = lock_registry();
    let path = trash_dir().join(&file_name);
    if path.is_file() && !is_symlink_path(&path) {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        let mut reg = read_trash_registry();
        reg.retain(|(f, _, _)| f != &file_name);
        let _ = write_trash_registry(&reg);
        // The note is gone for good — drop its pin as well.
        unpin(&file_name);
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn empty_trash() -> Result<bool, String> {
    // Every .md file in Trash/ is destroyed (the folder is the app's own
    // trash — the registry in trash.json only remembers which folder a
    // note came from). Files that are not .md are left alone.
    let _guard = lock_registry();
    let dir = trash_dir();
    let mut emptied: Vec<String> = Vec::new();
    let mut failures = 0usize;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_symlink_path(&path) {
                continue;
            }
            if path.is_file() && has_md_extension(&path) {
                if fs::remove_file(&path).is_ok() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        emptied.push(name.to_string());
                    }
                } else {
                    // Count the misses: a silent skip would report success
                    // even when files survive on disk.
                    failures += 1;
                }
            }
        }
    }
    if failures == 0 {
        let _ = fs::remove_file(trash_registry_path());
    } else {
        // Keep the folder attribution of the notes that survived: dropping
        // the whole registry would leave them listed with no home to
        // restore to. Entries whose file is gone (the ones just emptied,
        // or already stale) are dropped.
        let survivors: Vec<(String, String, String)> = read_trash_registry()
            .into_iter()
            .filter(|(f, _, _)| trash_dir().join(f).is_file())
            .collect();
        let _ = write_trash_registry(&survivors);
    }
    // The pins of the emptied notes are stale now.
    unpin_many(&emptied);
    if failures > 0 {
        return Err(format!(
            "{} note(s) in Trash could not be permanently deleted (the destination may be locked or read-only).",
            failures
        ));
    }
    Ok(true)
}

// ===========================================================================
// EXPORT — write .md copies into an Exports/ folder next to the exe .
// No save dialog plugin needed; the folder is right next to the app.
// ===========================================================================

fn exports_dir() -> PathBuf {
    let dir = get_app_dir().join("Exports");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// The export path for a note inside `dir`.
///
/// Two notes in different folders can share a bare file name (the app
/// identifies notes by their bare name). Exporting both to
/// `Exports/<name>.md` would let the second overwrite the first and
/// silently lose a note.
///
/// The rule here: reuse `dir/<name>.md` when it is free or already holds
/// EXACTLY this content (a refresh of the same note); otherwise take the
/// first free "stem_N.md" slot — or one that already holds this content,
/// so exporting twice does not pile up a new file every time.
fn export_path_for(dir: &Path, file_name: &str, content: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    if read_note_content(&candidate) == content {
        return candidate;
    }
    let stem = md_stem(file_name);
    let mut n = 1u32;
    loop {
        let candidate = dir.join(format!("{}_{}.md", stem, n));
        if !candidate.exists() {
            return candidate;
        }
        if read_note_content(&candidate) == content {
            return candidate;
        }
        if n == u32::MAX {
            let mut rng = rand::thread_rng();
            return dir.join(format!("{}_{}_{}.md", stem, n, rng.gen::<u64>()));
        }
        n += 1;
    }
}

#[tauri::command]
fn export_note(file_name: String) -> Result<String, String> {
    if !is_safe_bare_md_name(&file_name) {
        return Err("Invalid note file name".to_string());
    }
    // Serialize the pick-a-free-export-path + write pair: two concurrent
    // exports of same-named notes could otherwise both pick the same free
    // slot and the second overwrite the first.
    let _guard = lock_registry();
    let (path, _) = find_note_path(&file_name)
        .ok_or_else(|| "Note not found.".to_string())?;
    // Lossy read: an export must never fail (or lose readable text) just
    // because one byte in the note is invalid UTF-8.
    let content = read_note_content(&path);
    if content.len() > MAX_CONTENT_BYTES {
        return Err("Note is too large to export.".to_string());
    }
    let dest = export_path_for(&exports_dir(), &file_name, &content);
    atomic_write_file(&dest, &content)?;
    Ok(dest.display().to_string())
}

#[tauri::command]
fn export_all_notes() -> Result<String, String> {
    // Same serialization as export_note (see there): the per-note
    // pick-a-free-slot + write pairs must not interleave with each other
    // or with a concurrent export.
    let _guard = lock_registry();
    let notes = get_notes()?;
    let dir = exports_dir();
    let mut count = 0;
    let mut failures = 0usize;
    for note in &notes {
        if note.content.len() > MAX_CONTENT_BYTES {
            failures += 1;
            continue;
        }
        // Never overwrite another note's export (see export_path_for).
        let dest = export_path_for(&dir, &note.file_name, &note.content);
        if atomic_write_file(&dest, &note.content).is_ok() {
            count += 1;
        } else {
            failures += 1;
        }
    }
    let suffix = if failures > 0 { format!(" ({} failed)", failures) } else { String::new() };
    Ok(format!("{} note{} exported to {}{}", count, if count == 1 { "" } else { "s" }, dir.display(), suffix))
}

#[tauri::command]
fn move_notes(file_names: Vec<String>, target_folder: String) -> Result<bool, String> {
    if file_names.len() > 500 {
        return Err("Too many notes in one batch.".to_string());
    }
    let _guard = lock_registry();
    // The validated resolver — traversal can never escape Notes/.
    let dest_dir = resolve_folder_dir(&target_folder)?;
    if !dest_dir.exists() {
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    }

    let mut failures = 0usize;
    for name in &file_names {
        if is_safe_bare_md_name(name) {
            if let Some((old_path, _)) = find_note_path(name) {
                let new_path = dest_dir.join(name);
                if old_path == new_path {
                    continue;
                }
                // The same file reached through a case-variant spelling of
                // its folder ("Work" vs "work" is one directory on NTFS):
                // the destination "exists" but it IS the note being moved,
                // so this is a no-op, not a collision to suffix. Without
                // this check the note would be renamed to *_moved.md for
                // moving into the folder it already lives in.
                if new_path.exists() {
                    if let (Ok(a), Ok(b)) =
                        (old_path.canonicalize(), new_path.canonicalize())
                    {
                        if a == b {
                            continue;
                        }
                    }
                }
                // fs::rename silently overwrites a same-name
                // destination on Windows. Keep both files: if the target
                // already holds a different note, suffix the incoming one.
                if new_path.exists() {
                    let stem = md_stem(name);
                    let mut suffix = "_moved.md".to_string();
                    let mut candidate_name = format!("{}{}", stem_fitting(stem, &suffix), suffix);
                    let mut candidate = dest_dir.join(&candidate_name);
                    let mut n = 0u32;
                    while candidate.exists() {
                        n += 1;
                        suffix = format!("_moved_{}.md", n);
                        candidate_name = format!("{}{}", stem_fitting(stem, &suffix), suffix);
                        candidate = dest_dir.join(&candidate_name);
                    }
                    if fs::rename(old_path, candidate).is_err() {
                        failures += 1;
                    } else {
                        transfer_pin(name, &candidate_name);
                    }
                } else if fs::rename(old_path, new_path).is_err() {
                    failures += 1;
                }
            }
        }
    }

    rewrite_backup();

    // Report partial failure instead of claiming a clean move — the UI then
    // refreshes and the user sees what actually happened on disk.
    if failures > 0 {
        return Err(format!(
            "{} note(s) could not be moved (the destination may be locked or read-only).",
            failures
        ));
    }
    Ok(true)
}

#[tauri::command]
fn get_folders() -> Result<Vec<FolderInfo>, String> {
    let notes_dir = get_notes_dir();
    // Start from the registry (source of truth), then add any directory on
    // disk that is not registered yet (e.g. created by hand). A folder shows
    // even if its directory could not be created.
    //
    // The registry is hand-editable JSON: drop entries that could never be
    // a real folder — a crafted ".." or absolute path would make the count
    // loop below read_dir() an arbitrary directory — and dedupe
    // case-insensitively (NTFS), so one folder never shows on two rows.
    // "Root" is the backup-file label for the empty folder, never a real
    // folder name, so a registry entry for it is dropped like any other
    // unusable name.
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for n in read_folders_registry() {
        if n.eq_ignore_ascii_case("root") {
            continue;
        }
        if clean_folder_name(&n).as_deref() == Some(n.as_str()) && seen.insert(n.to_lowercase()) {
            names.push(n);
        }
    }
    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !is_symlink_path(&path) {
                let name = entry.file_name().to_string_lossy().to_string();
                if seen.insert(name.to_lowercase()) {
                    names.push(name);
                }
            }
        }
    }

    let mut folders = Vec::new();
    for name in names {
        let mut count = 0;
        let dir = notes_dir.join(&name);
        if dir.is_dir() && !is_symlink_path(&dir) {
            if let Ok(subs) = fs::read_dir(&dir) {
                for sub in subs.flatten() {
                    let sp = sub.path();
                    if sp.is_file() && !is_symlink_path(&sp) && has_md_extension(&sp) {
                        count += 1;
                    }
                }
            }
        }
        folders.push(FolderInfo { name, count });
    }

    folders.sort_by_key(|a| a.name.to_lowercase());
    Ok(folders)
}

#[tauri::command]
fn create_folder(folder_name: String) -> Result<bool, String> {
    let clean_name = match clean_folder_name(&folder_name) {
        Some(n) => n,
        None => return Err("Invalid folder name".to_string()),
    };
    // "Root" is the backup-file label for the empty folder: a real folder
    // with that name would be written to the backup as FOLDER: Root and
    // restored into the root instead.
    if clean_name.eq_ignore_ascii_case("root") {
        return Err("Invalid folder name".to_string());
    }

    // A symlinked directory with this name must never be registered as a
    // folder: note operations refuse to write through symlinked folders,
    // so the folder would appear in the UI and accept nothing. Checked
    // before the registry write, so a rejected name leaves no entry behind.
    let path = get_notes_dir().join(&clean_name);
    if path.exists() && is_symlink_path(&path) {
        return Err("Invalid folder name".to_string());
    }

    // Register first: the registry write is a plain file write next to the
    // exe, so the folder is guaranteed to exist in the UI even if directory
    // creation fails on this machine. If the registry write fails, still
    // try the directory — a folder that exists on disk is listed by
    // get_folders too, so the folder appears either way. Only fail if both
    // are impossible.
    let _reg_guard = lock_registry();
    let mut names = read_folders_registry();
    // A case-only variant of an existing folder is the same directory on
    // NTFS — registering both shows one folder on two rows (the same
    // phantom split rename_folder rejects for renames).
    if names.iter().any(|n| n.eq_ignore_ascii_case(&clean_name)) {
        return Err("A folder with that name already exists.".to_string());
    }
    let mut registry_ok = true;
    let mut registry_err = String::new();
    if !names.contains(&clean_name) {
        names.push(clean_name.clone());
        if let Err(e) = write_folders_registry(&names) {
            registry_ok = false;
            registry_err = e;
        }
    }

    // Create the directory opportunistically. If this fails, the folder
    // still exists (registry) and the directory is created later when the
    // first note is moved into it — do NOT fail the whole command over it.
    let mut dir_ok = path.exists();
    if !dir_ok {
        dir_ok = fs::create_dir_all(&path).is_ok();
    }
    if registry_ok || dir_ok {
        return Ok(true);
    }
    Err(format!(
        "Could not create folder '{}' (registry: {}; path: {})",
        clean_name, registry_err, path.display()
    ))
}

#[tauri::command]
fn rename_folder(old_name: String, new_name: String) -> Result<bool, String> {
    let clean_new = match clean_folder_name(&new_name) {
        Some(n) => n,
        None => return Err("Invalid new folder name".to_string()),
    };
    // "Root" is the backup-file label for the empty folder (see
    // resolve_folder_dir): a real folder with that name breaks the
    // backup round-trip.
    if clean_new.eq_ignore_ascii_case("root") {
        return Err("Invalid new folder name".to_string());
    }

    let notes_dir = get_notes_dir();
    // The OLD name is untrusted IPC too — validate before joining.
    let clean_old = match clean_folder_name(&old_name) {
        Some(n) => n,
        None => return Err("Invalid folder name".to_string()),
    };
    // A case-only rename is a no-op for the directory on Windows but would
    // create a phantom registry case split — reject it up front.
    if clean_old.eq_ignore_ascii_case(&clean_new) && clean_old != clean_new {
        return Err("Case-only folder renames are not supported.".to_string());
    }
    let old_path = notes_dir.join(&clean_old);
    let new_path = notes_dir.join(&clean_new);
    // Never rename over an existing folder (fs::rename existing-dir
    // semantics vary by OS; overwriting/merge would lose notes).
    if new_path.exists() && old_path.exists() {
        return Err("A folder with that name already exists.".to_string());
    }
    // Neither end of the rename may be a symlink: renaming a symlinked
    // folder would only move the link, and the result would be a registered
    // folder note operations refuse to write through.
    if (new_path.exists() && is_symlink_path(&new_path))
        || (old_path.exists() && is_symlink_path(&old_path))
    {
        return Err("Invalid folder name".to_string());
    }

    let _reg_guard = lock_registry();
    // A folder that exists only in the registry (its directory is gone) has
    // no path to collide with — but renaming it onto a name that is ALREADY
    // registered would put that name in the registry twice, and the folder
    // panel would show the same folder on two rows. Reject it. Checked
    // inside the lock so a concurrent create_folder cannot slip the same
    // name in between the check and the registry write below. The registry
    // is read once here and reused below: the lock is held throughout, so
    // nothing else can change it in between.
    let mut names = read_folders_registry();
    if names.iter().any(|n| n == &clean_new) {
        return Err("A folder with that name already exists.".to_string());
    }
    // Rename the directory if it exists; a failure surfaces as an error.
    if old_path.exists() {
        if let Err(e) = fs::rename(&old_path, &new_path) {
            return Err(format!("Could not rename folder directory: {}", e));
        }
    }
    let mut changed = false;
    for n in names.iter_mut() {
        if *n == clean_old {
            *n = clean_new.clone();
            changed = true;
        }
    }
    if changed {
        write_folders_registry(&names)?;
        // Trashed notes remember their original folder by name; rewrite
        // those records too, or a restore resurrects the old folder.
        rename_trash_folder(&clean_old, &clean_new);
        // The backup records each note's folder, so it must be rewritten
        // after a rename — otherwise a restore puts the notes back in the
        // old folder.
        rewrite_backup();
        return Ok(true);
    }
    // Not in the registry: it was a disk-only folder. Register the new name
    // if the directory now exists under it.
    if new_path.exists() {
        rename_trash_folder(&clean_old, &clean_new);
        if !names.contains(&clean_new) {
            names.push(clean_new);
            write_folders_registry(&names)?;
        }
        // The backup records each note's folder, so it must be rewritten
        // after a rename — otherwise a restore puts the notes back in the
        // old folder. This branch rewrites it for the same reason.
        rewrite_backup();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn delete_folder(folder_name: String, delete_contained_notes: bool) -> Result<bool, String> {
    let notes_dir = get_notes_dir();
    // Validate BEFORE joining — a traversal string can never reach
    // remove_dir_all / renames.
    let clean = match clean_folder_name(&folder_name) {
        Some(n) => n,
        None => return Err("Invalid folder name".to_string()),
    };
    let _reg_guard = lock_registry();
    let folder_path = notes_dir.join(&clean);
    // A symlink/junction folder is never deleted through — only dropped
    // from the registry.
    let existed_on_disk = folder_path.exists() && folder_path.is_dir() && !is_symlink_path(&folder_path);

    if delete_contained_notes {
        if existed_on_disk {
            // Collect the note names first: destroying the notes must drop
            // their pins too, or pins.json keeps a stale entry (and a later
            // note reusing the name comes up pinned for no reason). The
            // permanent-delete and empty-trash paths unpin the same way.
            let mut destroyed: Vec<String> = Vec::new();
            if let Ok(entries) = fs::read_dir(&folder_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() && !is_symlink_path(&path) && has_md_extension(&path) {
                        if let Some(n) = path.file_name().and_then(|f| f.to_str()) {
                            destroyed.push(n.to_string());
                        }
                    }
                }
            }
            let remove_result = fs::remove_dir_all(&folder_path);
            // Only unpin notes that are actually gone: a partial
            // remove_dir_all must not unpin survivors.
            let gone: Vec<String> = destroyed
                .into_iter()
                .filter(|n| !folder_path.join(n).exists())
                .collect();
            unpin_many(&gone);
            // A failed destroy must not claim success: the folder and its
            // surviving notes are still on disk, so the registry entry
            // stays too and the user can retry.
            if let Err(e) = remove_result {
                return Err(format!(
                    "Could not delete folder '{}' ({}). Some notes may still be on disk.",
                    clean, e
                ));
            }
        }
    } else {
        // Move notes inside to root — collision-checked, never overwriting a
        // same-named note anywhere in the tree.
        if existed_on_disk {
            // Names taken anywhere outside this folder, collected once:
            // the check is global (root + every other subfolder), not just
            // the root directory, because notes are identified by bare
            // name. Each chosen name is added as it is used, so two notes
            // from this folder can never land on the same name either.
            let mut taken = note_names_except(&folder_path);
            let mut move_failures = 0usize;
            if let Ok(entries) = fs::read_dir(&folder_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if is_symlink_path(&path) {
                        continue;
                    }
                    if path.is_file() && has_md_extension(&path) {
                        if let Some(file_name) = path.file_name().and_then(|f| f.to_str()) {
                            let stem = md_stem(file_name);
                            let mut candidate = file_name.to_string();
                            let mut n = 1u32;
                            while taken.contains(&candidate.to_lowercase())
                                || notes_dir.join(&candidate).exists()
                            {
                                let suffix = format!("_{}.md", n);
                                candidate =
                                    format!("{}{}", stem_fitting(stem, &suffix), suffix);
                                if n == u32::MAX {
                                    let mut rng = rand::thread_rng();
                                    let suffix =
                                        format!("_{}_{}.md", n, rng.gen::<u64>());
                                    candidate = format!(
                                        "{}{}",
                                        stem_fitting(stem, &suffix),
                                        suffix
                                    );
                                    break;
                                }
                                n += 1;
                            }
                            taken.insert(candidate.to_lowercase());
                            let new_dest = notes_dir.join(&candidate);
                            if fs::rename(&path, &new_dest).is_err() {
                                move_failures += 1;
                            } else if candidate != file_name {
                                transfer_pin(file_name, &candidate);
                            }
                        }
                    }
                }
            }
            // A note that could not be moved is still in the folder: say
            // so instead of deleting the folder around it and claiming
            // success.
            if move_failures > 0 {
                return Err(format!(
                    "{} note(s) could not be moved to the root folder (the destination may be locked or read-only).",
                    move_failures
                ));
            }
            // Remove ONLY the directory itself, and only when it is empty
            // now. remove_dir_all() here would delete non-note files the
            // user may have placed in the folder (images, sub-folders) —
            // the delete_contained_notes=false contract is "keep everything
            // except the folder itself". If leftovers remain, say so
            // instead of deleting them: the folder stays, the registry keeps
            // it, and the user sees why.
            match fs::remove_dir(&folder_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "Folder still contains items that are not notes ({}). Move or delete them first.",
                        e
                    ));
                }
            }
        }
    }

    // Always drop it from the registry, so the folder disappears from the
    // UI even if the directory was already gone.
    let mut names = read_folders_registry();
    let before = names.len();
    names.retain(|n| n != &clean);
    if names.len() != before {
        write_folders_registry(&names)?;
        rewrite_backup();
        return Ok(true);
    }

    if existed_on_disk {
        rewrite_backup();
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
fn get_settings() -> Result<AppSettings, String> {
    let path = get_app_dir().join("settings.json");
    if path.exists() {
        // lossy read — a single odd byte must not silently reset
        // the user's theme/zoom to the defaults.
        let data = read_note_content(&path);
        if !data.trim().is_empty() {
            if let Ok(settings) = serde_json::from_str::<AppSettings>(&data) {
                return Ok(sanitize_settings(settings));
            }
        }
    }

    Ok(AppSettings::default())
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<bool, String> {
    let settings = sanitize_settings(settings);
    let path = get_app_dir().join("settings.json");
    // Atomic write: a crash halfway through must not leave a truncated
    // settings.json that then fails to parse (and resets the user's theme).
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write_file(&path, &json)?;
    Ok(true)
}

#[tauri::command]
fn toggle_pin(file_name: String, pinned: bool) -> Result<bool, String> {
    if !is_safe_bare_md_name(&file_name) {
        return Err("Invalid note file name".to_string());
    }
    let _guard = lock_registry();
    // Checked inside the lock: a note deleted between this check and the
    // write would otherwise leave a pin for a note that no longer exists,
    // and a later note reusing the name would come up pinned for no reason.
    if !note_exists_anywhere(&file_name) {
        return Err("Note not found.".to_string());
    }
    let mut pins = read_pins();
    if pinned {
        pins.insert(file_name);
    } else {
        pins.remove(&file_name);
    }
    write_pins(&pins)?;
    Ok(true)
}

#[tauri::command]
fn restore_backup() -> Result<RestoreResult, String> {
    let _guard = lock_registry();
    // Fall back to the previous generation when the newest backup is
    // missing — one lost file must not mean no backup at all. (A
    // present-but-corrupted newest backup is read lossily instead;
    // the previous generation is not consulted in that case.)
    let backup_path = get_app_dir().join("All Notes.txt");
    let backup_path = if backup_path.exists() {
        backup_path
    } else {
        get_app_dir().join("All Notes.previous.txt")
    };
    if !backup_path.exists() {
        return Ok(RestoreResult {
            restored_count: 0,
            message: "No backup file 'All Notes.txt' found next to the executable.".to_string(),
        });
    }

    // Align with the writer (80 '=' dividers, line-anchored FILE:/FOLDER:
    // parsing that keeps spaces), validate the restored folder through
    // resolve_folder_dir, cap restored content, write atomically, and
    // refresh the backup at the end.
    //
    // The backup is read LOSSILY: one invalid byte anywhere in All
    // Notes.txt must not make the ENTIRE restore fail, even though every
    // other note in the file is perfectly readable.
    let backup_content = read_note_content(&backup_path);
    if backup_content.trim().is_empty() {
        return Ok(RestoreResult {
            restored_count: 0,
            message: "The backup file 'All Notes.txt' is empty.".to_string(),
        });
    }
    // Entries come from parse_backup_entries (complete
    // divider + FILE: + divider triplets), so a divider line inside a note
    // body cannot split or truncate the note.
    let entries = parse_backup_entries(&backup_content);

    // The names that already exist on disk, collected ONCE. Calling
    // find_note_path() for every backup entry would re-scan the whole
    // Notes/ tree each time — a 1000-note backup would mean 1000 full
    // directory scans (O(n²)).
    //
    // The names are lower-cased because the filesystem is case-insensitive
    // on Windows: a backup entry "NOTE.MD" must be recognised as the live
    // note "note.md" and must NOT overwrite it.
    let mut existing_names = list_note_names();
    let trashed_names = list_trash_names();

    let mut restored_count = 0;
    let mut failures = 0usize;

    for (header_line, body) in entries {
        let note_content = strip_backup_framing(body);

        let parts: Vec<&str> = header_line.split('|').collect();
        // The value of a `KEY: value` header part, matched on the key
        // case-insensitively without allocating a lower-cased copy of
        // every part of every entry.
        let header_value = |key: &str| -> String {
            parts
                .iter()
                .find(|p| {
                    p.trim_start()
                        .get(..key.len())
                        .map(|prefix| prefix.eq_ignore_ascii_case(key))
                        .unwrap_or(false)
                })
                .map(|s| s.split_once(':').map(|(_, v)| v.trim().to_string()).unwrap_or_default())
                .unwrap_or_default()
        };
        let file_name = header_value("file:");
        let folder_name = header_value("folder:");
        let folder_clean = if folder_name.eq_ignore_ascii_case("Root") { String::new() } else { folder_name };

        if !is_safe_bare_md_name(&file_name) {
            continue;
        }
        // Never overwrite a live note, never resurrect a deliberately
        // trashed one.
        let key = file_name.to_lowercase();
        if existing_names.contains(&key) || trashed_names.contains(&key) {
            continue;
        }
        if note_content.len() > MAX_CONTENT_BYTES {
            continue;
        }
        // The folder comes from the backup file, which is hand-editable: an
        // invalid name must not make the note unrestorable — it lands in
        // the root folder instead of being skipped.
        let target_dir = resolve_folder_dir(&folder_clean).unwrap_or_else(|_| get_notes_dir());
        if !target_dir.exists() {
            let _ = fs::create_dir_all(&target_dir);
        }
        let file_path = target_dir.join(&file_name);
        if atomic_write_file(&file_path, note_content).is_ok() {
            restored_count += 1;
            // A duplicate header later in the same backup must not create a
            // second file for the same note.
            existing_names.insert(key);
        } else {
            failures += 1;
        }
    }

    if restored_count > 0 {
        rewrite_backup();
    }

    let message = if restored_count > 0 {
        let suffix = if failures > 0 {
            format!(" ({} note(s) could not be restored — the destination may be locked or read-only).", failures)
        } else {
            String::new()
        };
        format!("Successfully restored {} missing note(s) from All Notes.txt without overwriting existing files.{}", restored_count, suffix)
    } else if failures > 0 {
        format!("{} note(s) in the backup could not be restored (the destination may be locked or read-only). No files were overwritten.", failures)
    } else {
        "All notes in backup are already present. No missing notes to restore.".to_string()
    };

    Ok(RestoreResult {
        restored_count,
        message,
    })
}

// Where the portable data lives (Notes/, settings.json, All Notes.txt).
// Exposed so Settings can offer "Open data folder" without hardcoding a path.
#[tauri::command]
fn get_app_dir_path() -> Result<String, String> {
    Ok(get_app_dir().display().to_string())
}

// Open the portable data folder (Notes/, settings.json, All Notes.txt) in
// Explorer.
//
// This is a Rust-side opener call (OpenerExt::open_path), not a webview
// invoke: it opens exactly the computed data directory and nothing else,
// and it is not subject to the opener plugin's webview path scope or its
// `allow-open-path` permission, which gate only JavaScript-invoked
// `plugin:opener|open_path` calls. No capability entry for it is needed.
#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(
            get_app_dir().to_string_lossy().to_string(),
            None::<String>,
        )
        .map_err(|e| format!("Could not open the data folder: {e}"))
}

// Copy the live All Notes.txt backup into Exports/ so "Export All Notes.txt"
// works in the desktop app. The backup is regenerated first if it is
// somehow missing.
#[tauri::command]
fn export_backup() -> Result<String, String> {
    let src = get_app_dir().join("All Notes.txt");
    if !src.is_file() {
        // Serialize the regen with rewrite_backup(): both rewrite the same
        // file via temp + rename, and an unlocked regen here could land
        // after a mutation's rewrite but from an older scan.
        let _guard = lock_backup();
        rewrite_backup_atomic(&collect_notes())?;
    }
    // Lossy read, like export_note: an export must never fail (or lose
    // readable text) just because one byte in the backup is invalid UTF-8.
    let content = read_note_content(&src);
    let dest = exports_dir().join("All Notes.txt");
    atomic_write_file(&dest, &content)?;
    Ok(dest.display().to_string())
}

// Native WebView zoom (the standard, robust way to scale the UI).
// CSS `zoom` on <html> is non-standard and breaks the app: at high zoom the
// layout overflows the overflow-hidden window and buttons — including the
// Settings zoom control itself — get pushed off-screen with no way back.
// The WebView's own zoom factor (WebView2 SetZoomFactor on Windows) scales
// the whole page the way a browser zoom does: layout reflows, nothing gets
// stuck, and fixed/portal coordinates stay correct.
#[tauri::command]
fn set_window_zoom(window: tauri::WebviewWindow, zoom: u32) -> Result<bool, String> {
    let clamped = zoom.clamp(90, 150);
    window
        .set_zoom(clamped as f64 / 100.0)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

// ============================================================================
// APPLICATION ENTRY POINT
// ============================================================================

pub fn run() {
    tauri::Builder::default()
        // Single instance, registered first: a portable exe is easy to
        // double-launch, and two copies would autosave over each other
        // (every registry lock in this file is process-local). A second
        // launch just focuses the running window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_notes,
            create_note,
            save_note,
            delete_note,
            move_notes,
            get_trash,
            restore_note,
            delete_note_permanent,
            empty_trash,
            export_note,
            export_all_notes,
            get_folders,
            create_folder,
            rename_folder,
            delete_folder,
            get_settings,
            save_settings,
            toggle_pin,
            restore_backup,
            get_app_dir_path,
            open_data_dir,
            export_backup,
            set_window_zoom
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio application");
}

// ============================================================================
// TESTS — folder commands
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize the folder tests: they share one folders.json registry file,
    // and its read-modify-write would race if the tests ran in parallel.
    static FOLDER_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn unique_name(prefix: &str) -> String {
        format!(
            "{}_{}_{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        )
    }

    fn cleanup(name: &str) {
        let _ = fs::remove_dir_all(get_notes_dir().join(name));
        // Also drop it from the registry so a failed test does not leak a
        // folder into the next run.
        let mut names = read_folders_registry();
        let before = names.len();
        names.retain(|n| n != name);
        if names.len() != before {
            let _ = write_folders_registry(&names);
        }
    }

    #[test]
    fn create_folder_appears_in_get_folders() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let name = unique_name("testfolder");
        let ok = create_folder(name.clone()).expect("create_folder should succeed");
        assert!(ok, "create_folder should return true");
        assert!(
            get_notes_dir().join(&name).is_dir(),
            "folder dir should exist on disk after create_folder"
        );
        let folders = get_folders().expect("get_folders should succeed");
        assert!(
            folders.iter().any(|f| f.name == name),
            "new folder should appear in get_folders; got: {:?}",
            folders.iter().map(|f| &f.name).collect::<Vec<_>>()
        );
        cleanup(&name);
    }

    #[test]
    fn create_folder_rejects_empty_name() {
        let res = create_folder(" ".to_string());
        assert!(res.is_err(), "whitespace-only folder name must be rejected");
        let res = create_folder("".to_string());
        assert!(res.is_err(), "empty folder name must be rejected");
    }

    #[test]
    fn create_folder_rejects_invalid_windows_names() {
        // Reserved device names + trailing dot — all invalid on Windows.
        // (A trailing space is trimmed, not rejected — see the trim test.)
        for bad in ["CON", "con", "PRN", "AUX", "NUL", "COM1", "LPT9", "COM1.txt", "My Folder."] {
            let res = create_folder(bad.to_string());
            assert!(res.is_err(), "name {:?} must be rejected", bad);
        }
    }

    #[test]
    fn get_folders_ignores_root_in_registry() {
        // "Root" is the backup-file label for the empty folder, never a
        // real folder name: a registry entry for it must not show up as
        // a folder row, just like create_folder refuses to create it.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let mut names = read_folders_registry();
        names.push("Root".to_string());
        write_folders_registry(&names).unwrap();
        let folders = get_folders().expect("get_folders should succeed");
        assert!(
            !folders.iter().any(|f| f.name.eq_ignore_ascii_case("root")),
            "\"Root\" must not appear in get_folders; got {:?}",
            folders.iter().map(|f| &f.name).collect::<Vec<_>>()
        );
        let mut names = read_folders_registry();
        names.retain(|n| !n.eq_ignore_ascii_case("root"));
        let _ = write_folders_registry(&names);
    }

    #[test]
    fn create_folder_trims_and_keeps_good_names() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let name = unique_name("trimmed");
        let spaced = format!(" {} ", name);
        assert!(create_folder(spaced).unwrap());
        assert!(
            get_notes_dir().join(&name).is_dir(),
            "name should be trimmed before creating the dir"
        );
        cleanup(&name);
    }

    #[test]
    fn create_folder_rejects_symlinked_directory() {
        // A symlinked directory with the folder's name must never be
        // registered: note operations refuse to write through symlinked
        // folders, so the folder would appear in the UI and accept nothing.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let name = unique_name("symlinkfolder");
        let target = get_notes_dir().join(unique_name("symlinktarget"));
        let _ = fs::create_dir_all(&target);
        let linked = {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&target, get_notes_dir().join(&name)).is_ok()
            }
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(&target, get_notes_dir().join(&name)).is_ok()
            }
            #[cfg(not(any(unix, windows)))]
            {
                false
            }
        };
        if !linked {
            // No privilege to create a symlink here; nothing to test.
            let _ = fs::remove_dir_all(&target);
            return;
        }
        let res = create_folder(name.clone());
        assert!(res.is_err(), "a symlinked folder name must be rejected");
        assert!(
            !read_folders_registry().iter().any(|n| n == &name),
            "the symlinked name must not be registered"
        );
        let _ = fs::remove_file(get_notes_dir().join(&name));
        let _ = fs::remove_dir_all(&target);
        cleanup(&name);
    }

    #[test]
    fn rename_folder_moves_dir_and_notes() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let old = unique_name("oldfolder");
        let new = unique_name("newfolder");
        assert!(create_folder(old.clone()).unwrap());
        // put a note in it so rename must carry the contents
        let note = generate_safe_file_name("rename test note");
        let note_path = get_notes_dir().join(&old).join(&note);
        fs::write(&note_path, "hello").unwrap();
        assert!(rename_folder(old.clone(), new.clone()).unwrap());
        assert!(!get_notes_dir().join(&old).exists(), "old dir should be gone");
        assert!(get_notes_dir().join(&new).is_dir(), "new dir should exist");
        assert!(
            get_notes_dir().join(&new).join(&note).exists(),
            "note should have moved with the folder"
        );
        cleanup(&new);
    }

    #[test]
    fn delete_folder_removes_dir() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let name = unique_name("delfolder");
        assert!(create_folder(name.clone()).unwrap());
        assert!(delete_folder(name.clone(), true).unwrap());
        assert!(!get_notes_dir().join(&name).exists(), "dir should be gone");
    }

    #[test]
    fn delete_folder_keeps_notes_when_asked() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let name = unique_name("keepfolder");
        assert!(create_folder(name.clone()).unwrap());
        let note = generate_safe_file_name("keep me");
        let note_path = get_notes_dir().join(&name).join(&note);
        fs::write(&note_path, "keep").unwrap();
        assert!(delete_folder(name.clone(), false).unwrap());
        assert!(!get_notes_dir().join(&name).exists(), "dir should be gone");
        assert!(
            get_notes_dir().join(&note).exists(),
            "note should have moved to root when delete_contained_notes=false"
        );
        let _ = fs::remove_file(get_notes_dir().join(&note));
    }

    #[test]
    fn delete_folder_keeps_notes_without_duplicate_names() {
        // Folder A and folder B both hold a note with the same bare name
        // (placed by hand). Deleting A with "keep the notes" must move
        // A's note to the root under a suffixed name — never onto B's
        // note, and never as a second note with the same bare name.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let folder_a = unique_name("dupA");
        let folder_b = unique_name("dupB");
        assert!(create_folder(folder_a.clone()).unwrap());
        assert!(create_folder(folder_b.clone()).unwrap());
        let name = format!("{}.md", unique_name("dupname"));
        fs::write(get_notes_dir().join(&folder_a).join(&name), "FROM A").unwrap();
        fs::write(get_notes_dir().join(&folder_b).join(&name), "FROM B").unwrap();
        assert!(delete_folder(folder_a.clone(), false).unwrap());
        assert!(
            get_notes_dir().join(&folder_b).join(&name).exists(),
            "B's note must be untouched"
        );
        let notes = get_notes().expect("get_notes should succeed");
        let from_a: Vec<_> = notes.iter().filter(|n| n.content == "FROM A").collect();
        assert_eq!(from_a.len(), 1, "exactly one FROM A note must exist");
        assert_ne!(from_a[0].file_name, name, "A's moved note must be suffixed");
        assert_eq!(from_a[0].folder, "", "A's note must have moved to the root");
        // Cleanup.
        let _ = fs::remove_file(get_notes_dir().join(&from_a[0].file_name));
        let _ = fs::remove_file(get_notes_dir().join(&folder_b).join(&name));
        cleanup(&folder_a);
        cleanup(&folder_b);
    }

    #[test]
    fn registry_folder_survives_without_directory() {
        // The registry is the source of truth: the folder exists in the
        // UI even when its directory is gone.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let name = unique_name("regfolder");
        assert!(create_folder(name.clone()).unwrap());
        // Remove the directory by hand: the folder must STILL be listed,
        // because the registry is the source of truth.
        let _ = fs::remove_dir_all(get_notes_dir().join(&name));
        assert!(!get_notes_dir().join(&name).exists());
        let folders = get_folders().expect("get_folders should succeed");
        assert!(
            folders.iter().any(|f| f.name == name),
            "registry folder must appear in get_folders even without a directory"
        );
        // And deleting it removes it from the registry too.
        assert!(delete_folder(name.clone(), true).unwrap());
        let folders = get_folders().expect("get_folders should succeed");
        assert!(
            !folders.iter().any(|f| f.name == name),
            "deleted folder must disappear from get_folders"
        );
        cleanup(&name);
    }

    #[test]
    fn save_note_round_trips_and_rejects_missing_note() {
        // A missing file must be refused with an Err (never silently
        // re-created in the root Notes dir — re-creating it would
        // resurrect a note a late autosave raced with a delete). The Err
        // also routes the frontend through its failure path, which parks
        // the typed text in the localStorage mirror instead of dropping it.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let note = create_note("hello world".to_string(), "".to_string())
            .expect("create_note should succeed");
        assert!(save_note(note.file_name.clone(), "hello world EDITED".to_string()).unwrap());
        let notes = get_notes().expect("get_notes should succeed");
        let back = notes.iter().find(|n| n.file_name == note.file_name).expect("note should exist");
        assert_eq!(back.content, "hello world EDITED");
        let _ = fs::remove_file(get_notes_dir().join(&note.file_name));

        // Missing file: must be refused. Writing it here would resurrect a
        // note the user had just deleted (a late autosave racing the delete).
        let ghost = unique_name("ghost");
        let ghost = format!("{}.md", ghost);
        assert!(save_note(ghost.clone(), "ghost content".to_string()).is_err());
        let p = get_notes_dir().join(&ghost);
        assert!(!p.is_file(), "ghost file must NOT be created");
    }

    #[test]
    fn trash_one_generates_unique_names_on_rapid_calls() {
        // two deletes of same-named notes in the same second must
        // both survive (name has nanos + random hex suffix).
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let base = unique_name("trashuniq");
        let file_name = format!("{}.md", base);
        let dir = trash_dir();
        // Seed a trashed file with the collision target name.
        let seed = dir.join(&file_name);
        fs::write(&seed, "first").unwrap();
        // Add a registry entry for the seed.
        let mut reg = read_trash_registry();
        reg.push((file_name.clone(), "".to_string(), Local::now().to_rfc3339()));
        write_trash_registry(&reg).unwrap();
        // Now trash a note that also has the same name: incoming source
        // lives in Notes/ root (different path, same bare name).
        let src = get_notes_dir().join(&file_name);
        fs::write(&src, "second").unwrap();
        trash_one(&src, &file_name, "").unwrap();
        // Both must exist as distinct trash entries.
        assert!(dir.join(&file_name).exists(), "seed must survive");
        assert_eq!(
            fs::read_to_string(dir.join(&file_name)).unwrap(),
            "first".to_string(),
            "seed content must not be overwritten"
        );
        let trashed = get_trash().expect("get_trash should succeed");
        let matches: Vec<_> = trashed
            .iter()
            .filter(|n| n.content == "second" || n.content == "first")
            .collect();
        assert!(
            matches.len() >= 2,
            "both contents must be in trash; got {:?}",
            trashed.iter().map(|n| (&n.file_name, &n.content)).collect::<Vec<_>>()
        );
        // Cleanup: delete forever both, incl. the "second" (suffixed) copy.
        for n in &trashed {
            if n.content == "first" || n.content == "second" {
                let _ = delete_note_permanent(n.file_name.clone());
            }
        }
        let _ = fs::remove_file(&seed);
        let mut reg = read_trash_registry();
        reg.retain(|(f, _, _)| !f.starts_with(&base));
        let _ = write_trash_registry(&reg);
        assert!(!src.exists(), "source must be gone after trash_one");
    }

    #[test]
    fn trash_one_keeps_first_trashed_notes_folder() {
        // Trashing a second note with the same bare name must not drop
        // the first trashed note's registry entry: its file is still in
        // Trash/ and still needs its original folder to restore to.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let folder = unique_name("trashfolder");
        assert!(create_folder(folder.clone()).unwrap());
        let base = unique_name("trashkeep");
        let file_name = format!("{}.md", base);
        let dir = trash_dir();
        let seed = dir.join(&file_name);
        fs::write(&seed, "first").unwrap();
        let mut reg = read_trash_registry();
        reg.push((file_name.clone(), folder.clone(), Local::now().to_rfc3339()));
        write_trash_registry(&reg).unwrap();
        let src = get_notes_dir().join(&file_name);
        fs::write(&src, "second").unwrap();
        trash_one(&src, &file_name, "").unwrap();
        let reg = read_trash_registry();
        assert!(
            reg.iter().any(|(f, fo, _)| f == &file_name && fo == &folder),
            "the first trashed note's folder entry must survive; got {reg:?}"
        );
        // Cleanup: delete forever both copies.
        for (f, _, _) in reg {
            if f == file_name || f.starts_with(&base) {
                let _ = delete_note_permanent(f);
            }
        }
        let _ = fs::remove_file(&seed);
        cleanup(&folder);
    }

    #[test]
    fn move_notes_keeps_both_files_on_name_collision() {
        // Moving a note onto a same-named destination must not overwrite it
        // on Windows — both files are kept, the incoming one gets a _moved
        // suffix.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let folder = unique_name("movetest");
        assert!(create_folder(folder.clone()).unwrap());
        let name = format!("{}.md", unique_name("movecollide"));
        // Existing note inside the folder, incoming note in root.
        let in_folder = get_notes_dir().join(&folder).join(&name);
        fs::write(&in_folder, "IN FOLDER").unwrap();
        let in_root = get_notes_dir().join(&name);
        fs::write(&in_root, "IN ROOT").unwrap();
        assert!(move_notes(vec![name.clone()], folder.clone()).unwrap());
        // Both contents must still exist somewhere under Notes/.
        let notes = get_notes().expect("get_notes should succeed");
        let all_contents: Vec<String> = notes.iter().map(|n| n.content.clone()).collect();
        assert!(all_contents.contains(&"IN FOLDER".to_string()), "folder note must survive; got {:?}", all_contents);
        assert!(all_contents.contains(&"IN ROOT".to_string()), "moved note must survive; got {:?}", all_contents);
        // The moved-in note must have a distinct (suffixed) file name.
        let moved_names: Vec<String> = notes
            .iter()
            .filter(|n| n.content == "IN ROOT")
            .map(|n| n.file_name.clone())
            .collect();
        assert_eq!(moved_names.len(), 1, "exactly one IN ROOT note; got {:?}", moved_names);
        assert_ne!(moved_names[0], name, "moved note must be suffixed, not overwrite");
        // Cleanup.
        for n in &notes {
            if n.content == "IN FOLDER" || n.content == "IN ROOT" {
                let _ = fs::remove_file(get_notes_dir().join(&folder).join(&n.file_name));
                let _ = fs::remove_file(get_notes_dir().join(&n.file_name));
            }
        }
        cleanup(&folder);
    }

    #[test]
    fn toggle_pin_persists_in_get_notes() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let note = create_note("pin me".to_string(), "".to_string())
            .expect("create_note should succeed");
        assert!(toggle_pin(note.file_name.clone(), true).unwrap());
        let notes = get_notes().expect("get_notes should succeed");
        let back = notes.iter().find(|n| n.file_name == note.file_name).expect("note should exist");
        assert!(back.pinned, "pinned note must report pinned=true from get_notes");
        let pins = read_pins();
        assert!(pins.contains(&note.file_name), "pins.json should list the note");
        assert!(toggle_pin(note.file_name.clone(), false).unwrap());
        let notes = get_notes().expect("get_notes should succeed");
        let back = notes.iter().find(|n| n.file_name == note.file_name).expect("note should exist");
        assert!(!back.pinned, "unpinned note must report pinned=false");
        let _ = fs::remove_file(get_notes_dir().join(&note.file_name));
    }

    #[test]
    fn toggle_pin_rejects_unknown_note() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let ghost = format!("{}.md", unique_name("pin-ghost"));
        assert!(toggle_pin(ghost, true).is_err(), "pinning a non-existent note must fail");
        assert!(toggle_pin("not-a-note.txt".to_string(), true).is_err(), "non-.md name must fail");
    }

    #[test]
    fn sanitize_settings_clamps_zoom_and_glassiness() {
        let s = sanitize_settings(AppSettings {
            theme: "light".to_string(),
            palette: "forest".to_string(),
            zoom: 999,
            spell_check: true,
            line_numbers: false,
            glassiness: 500,
            editor_font_size: 999,
            ..AppSettings::default()
        });
        assert_eq!(s.zoom, 150);
        assert_eq!(s.glassiness, 100);
        assert_eq!(s.editor_font_size, 26);
        let s = sanitize_settings(AppSettings {
            theme: "weird".to_string(),
            palette: "".to_string(),
            zoom: 1,
            spell_check: true,
            line_numbers: false,
            glassiness: 0,
            editor_font_size: 1,
            ..AppSettings::default()
        });
        assert_eq!(s.theme, "dark");
        assert_eq!(s.palette, "forest");
        assert_eq!(s.zoom, 90);
        assert_eq!(s.editor_font_size, 12);
    }

    #[test]
    fn save_note_rejects_oversized_content() {
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let big = "x".repeat(MAX_CONTENT_BYTES + 1);
        let ghost = format!("{}.md", unique_name("big"));
        assert!(save_note(ghost, big).is_err(), "oversized content must be rejected");
    }

    #[test]
    fn read_note_content_keeps_invalid_utf8_lossy() {
        // A .md file with invalid UTF-8 must not read as an empty string:
        // the note would show blank and a save would destroy the original
        // bytes. Lossy decode keeps the readable text.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let dir = get_notes_dir();
        let name = format!("{}.md", unique_name("badutf8"));
        let path = dir.join(&name);
        // Valid prefix + invalid bytes + valid suffix.
        let mut bytes = b"hello ".to_vec();
        bytes.extend_from_slice(&[0xFF, 0xFE, 0x80]);
        bytes.extend_from_slice(b" world");
        fs::write(&path, &bytes).unwrap();
        let content = read_note_content(&path);
        assert!(content.starts_with("hello "), "readable prefix must survive: {content:?}");
        assert!(content.ends_with(" world"), "readable suffix must survive: {content:?}");
        assert!(!content.is_empty(), "invalid UTF-8 must not blank the note");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pins_survive_invalid_utf8_in_pins_json() {
        // pins.json is read lossily, like every other read: an invalid
        // byte inside one entry must not wipe every pin (the next pin
        // write would then overwrite the file and lose them all).
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let original = fs::read(pins_path()).ok();
        let mut bytes = b"[\"keepme.md\", \"ba".to_vec();
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        bytes.extend_from_slice(b"d.md\"]");
        fs::write(pins_path(), &bytes).unwrap();
        let pins = read_pins();
        assert!(
            pins.contains("keepme.md"),
            "the valid pin must survive invalid UTF-8 elsewhere in pins.json; got {pins:?}"
        );
        // Restore the registry exactly as it was.
        match original {
            Some(b) => {
                let _ = fs::write(pins_path(), b);
            }
            None => {
                let _ = fs::remove_file(pins_path());
            }
        }
    }

    // ---------------------------------------------------------

    #[test]
    fn generated_name_never_contains_double_dots() {
        // "Wait... what" would otherwise produce a file name containing
        // "..", which the name validator rejects — the note would be
        // listed but every save refused.
        let name = generate_safe_file_name("Wait... what?!");
        assert!(!name.contains(".."), "name must not contain '..': {name}");
        assert!(is_safe_bare_md_name(&name), "generated name must be valid: {name}");
    }

    #[test]
    fn dotted_names_are_accepted_and_savable() {
        // A ".." INSIDE a name is a single path component, not a
        // traversal — it must be accepted so notes that already carry one
        // stay editable.
        assert!(is_safe_bare_md_name("2026-01-01_00-00-00_a..b_abcd1234.md"));
        assert!(!is_safe_bare_md_name("../evil.md"));
        assert!(!is_safe_bare_md_name("..md"));
        assert!(!is_safe_bare_md_name("a/b.md"));
        assert!(!is_safe_bare_md_name("a\\b.md"));
    }

    #[test]
    fn rename_folder_rejects_a_name_already_in_the_registry() {
        // Renaming a registry-only folder (its directory is gone) onto
        // an already-registered name would put that name in the registry
        // twice, and the folder panel would show one folder on two rows.
        // It must be refused.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let src = unique_name("renamesrc");
        let dst = unique_name("renamedst");
        assert!(create_folder(src.clone()).unwrap());
        assert!(create_folder(dst.clone()).unwrap());
        // Remove the directory so only the registry keeps the source folder.
        let _ = fs::remove_dir_all(get_notes_dir().join(&src));
        assert!(
            rename_folder(src.clone(), dst.clone()).is_err(),
            "renaming onto an existing folder name must be refused"
        );
        let names = read_folders_registry();
        assert_eq!(
            names.iter().filter(|n| *n == &dst).count(),
            1,
            "the folder name must not be registered twice: {names:?}"
        );
        cleanup(&src);
        cleanup(&dst);
    }

    #[test]
    fn save_note_round_trips_a_dotted_file_name() {
        // A note whose name carries ".." must still be writable.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let file_name = format!("{}.md", unique_name("dotted..name"));
        assert!(is_safe_bare_md_name(&file_name));
        let path = get_notes_dir().join(&file_name);
        fs::write(&path, "first").unwrap();
        assert!(save_note(file_name.clone(), "second".to_string()).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn created_at_is_taken_from_the_file_name_and_survives_a_save() {
        // Saving replaces the file (atomic rename), which gives it a new
        // filesystem creation time — the name prefix is the stable
        // creation time, so the "Created" sort does not jump the edited
        // note to the top.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let note = create_note("stable creation time".to_string(), "".to_string())
            .expect("create_note should succeed");
        let before = get_notes()
            .expect("get_notes should succeed")
            .into_iter()
            .find(|n| n.file_name == note.file_name)
            .expect("note should exist")
            .created_at;
        assert!(save_note(note.file_name.clone(), "edited".to_string()).unwrap());
        let after = get_notes()
            .expect("get_notes should succeed")
            .into_iter()
            .find(|n| n.file_name == note.file_name)
            .expect("note should exist")
            .created_at;
        assert_eq!(
            before, after,
            "created_at must not change when the note is edited"
        );
        assert!(!before.is_empty());
        let _ = fs::remove_file(get_notes_dir().join(&note.file_name));
    }

    #[test]
    fn create_note_created_at_matches_get_notes() {
        // The note create_note() returns must already carry the same
        // created_at get_notes() reports for it (derived from the name,
        // second precision), not a sub-second "now" that changes on the
        // next read.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let note = create_note("created at agrees".to_string(), "".to_string())
            .expect("create_note should succeed");
        let listed = get_notes()
            .expect("get_notes should succeed")
            .into_iter()
            .find(|n| n.file_name == note.file_name)
            .expect("note should exist");
        assert_eq!(note.created_at, listed.created_at);
        let _ = fs::remove_file(get_notes_dir().join(&note.file_name));
    }

    #[test]
    fn created_at_from_name_parses_the_timestamp_prefix() {
        assert_eq!(
            parse_name_timestamp("2026-11-12_09-05-03_hello_ab12cd34.md"),
            Some((2026, 11, 12, 9, 5, 3))
        );
        assert_eq!(parse_name_timestamp("no-timestamp-here.md"), None);
        assert_eq!(parse_name_timestamp("2026-13-45_99-99-99_bad_ab12cd34.md"), None);
        assert_eq!(
            parse_name_timestamp("2026-11-12_09-05-03.md"),
            Some((2026, 11, 12, 9, 5, 3))
        );
    }

    #[test]
    fn slug_turns_dots_into_word_separators() {
        // The slug must never contain a dot: a first line like "Wait... what"
        // would otherwise produce an unsaveable file name.
        assert_eq!(slug_from_content("Wait... what"), "Wait-what");
        assert_eq!(slug_from_content(" release"), "release");
        assert_eq!(slug_from_content(" \n spaced out "), "spaced-out");
        assert_eq!(slug_from_content(""), "");
        // The forbidden path characters are REPLACED by a space (not
        // removed), so the words stay separate and the Rust generator
        // agrees with the TypeScript one in utils.ts.
        assert_eq!(slug_from_content("a/b:c*d?e"), "a-b-c-d-e");
        assert!(!slug_from_content("Wait... what").contains('.'));
    }

    #[test]
    fn slug_drops_control_characters() {
        // A control character is not whitespace, so it must be replaced
        // explicitly — is_safe_bare_md_name() rejects control characters,
        // and a name carrying one could never be saved.
        assert_eq!(slug_from_content("hello\u{7}world"), "hello-world");
        assert_eq!(slug_from_content("a\u{0}b"), "a-b");
        // The generated NAME (not just the slug) must always be saveable.
        let name = generate_safe_file_name("hello\u{7}world");
        assert!(is_safe_bare_md_name(&name), "generated name must be valid: {name:?}");
        assert!(!name.chars().any(|c| c.is_control()));
    }

    #[test]
    fn every_generated_name_is_saveable() {
        // The safety net in generate_safe_file_name: no content, however
        // hostile, may produce a name that save_note() would refuse.
        let hostile = [
            "Wait... what",
            "\u{7}\u{1}\u{1f}",
            "a/b\\c:d*e?f\"g<h>i|j",
            " ",
            "",
            "\u{2028}line separator",
            "CON",
            "NUL.md",
        ];
        for content in hostile {
            let name = generate_safe_file_name(content);
            assert!(
                is_safe_bare_md_name(&name),
                "content {content:?} produced an unsaveable name {name:?}"
            );
        }
    }

    #[test]
    fn backup_framing_round_trips_exactly() {
        // The writer emits "\n{content}\n\n", so the reader must strip
        // exactly one leading and two trailing newlines — otherwise every
        // restore appends a stray "\n" to the note and the text grows on
        // every cycle.
        for content in ["hello", "hello\n", "hello\n\n", "\nleading", "trailing\n", ""] {
            let section = format!("\n{}\n\n", content);
            assert_eq!(
                strip_backup_framing(&section),
                content,
                "content {content:?} must survive the round trip"
            );
        }
    }

    #[test]
    fn export_path_does_not_overwrite_a_different_note() {
        // Two notes in different folders can share a bare name; the export
        // must never overwrite the first one.
        let dir = exports_dir();
        let name = format!("{}.md", unique_name("exportcollide"));
        let first = export_path_for(&dir, &name, "first content");
        fs::write(&first, "first content").unwrap();
        // The same content -> the same file (a refresh).
        assert_eq!(export_path_for(&dir, &name, "first content"), first);
        // Different content -> a different file, never an overwrite.
        let second = export_path_for(&dir, &name, "second content");
        assert_ne!(second, first);
        assert!(!second.exists());
        // And it is stable: exporting again picks the same slot.
        assert_eq!(export_path_for(&dir, &name, "second content"), second);
        let _ = fs::remove_file(&first);
    }

    #[test]
    fn backup_entries_ignore_divider_line_inside_body() {
        // A note body containing a FULL divider line (a Markdown setext
        // H1 underline is exactly that) must not split the backup — only a
        // divider followed by a FILE: header and another divider starts a
        // new entry.
        let divider = "=".repeat(80);
        let backup = format!(
            "# header\n{divider}\nFILE: a.md | FOLDER: Root | CREATED: x | MODIFIED: y\n{divider}\n\nMy heading\n{divider}\nmore body\n\n{divider}\nFILE: b.md | FOLDER: Root | CREATED: x | MODIFIED: y\n{divider}\n\nsecond body\n\n"
        );
        let entries = parse_backup_entries(&backup);
        assert_eq!(entries.len(), 2, "only the two real entries: {entries:?}");
        assert!(entries[0].0.contains("FILE: a.md"));
        let body_a = strip_backup_framing(entries[0].1);
        assert!(body_a.contains("My heading"), "body keeps its heading: {body_a:?}");
        assert!(body_a.contains(&divider), "body keeps its divider line: {body_a:?}");
        assert!(body_a.contains("more body"), "body keeps its tail: {body_a:?}");
        assert!(entries[1].0.contains("FILE: b.md"));
        assert_eq!(strip_backup_framing(entries[1].1), "second body");
    }

    #[test]
    fn backup_rewrite_keeps_exact_format() {
        // The backup writer shares the atomic writer now: the bytes must
        // still be exactly the documented format (header, 80 '=' dividers,
        // FILE: / FOLDER: / CREATED: / MODIFIED: headers, bodies).
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let note = create_note("format check".to_string(), "".to_string())
            .expect("create_note should succeed");
        let notes = get_notes().expect("get_notes should succeed");
        rewrite_backup_atomic(&notes).expect("rewrite_backup_atomic should succeed");
        let backup = fs::read_to_string(get_app_dir().join("All Notes.txt")).unwrap();
        assert!(backup.starts_with("# FOLIO BACKUP - ATOMIC ALL NOTES\n"));
        assert!(backup.contains(&format!("FILE: {} | FOLDER: Root |", note.file_name)));
        assert!(backup.contains(&"=".repeat(80)));
        assert!(backup.contains("format check"));
        let _ = fs::remove_file(get_notes_dir().join(&note.file_name));
    }

    #[test]
    fn reserved_device_name_with_extension_rejected() {
        // Windows reserves CON, PRN, AUX, NUL, COM1-9, LPT1-9 with
        // or without an extension — "CON.foo.md" is reserved like "CON.md".
        assert!(!is_safe_bare_md_name("CON.foo.md"));
        assert!(!is_safe_bare_md_name("con.md"));
        assert!(!is_safe_bare_md_name("NUL.txt.md"));
        assert!(is_safe_bare_md_name("concert.md"));
    }

    #[test]
    fn restore_backup_survives_invalid_utf8() {
        // The backup is read lossily: one invalid byte must not make the
        // whole restore fail.
        let _guard = FOLDER_TEST_LOCK.lock().unwrap();
        let app_dir = get_app_dir();
        let backup_path = app_dir.join("All Notes.txt");
        let existed = backup_path.is_file();
        let original = if existed {
            Some(fs::read(&backup_path).unwrap())
        } else {
            None
        };
        let divider = "=".repeat(80);
        let name = format!("{}.md", unique_name("lossyrestore"));
        let mut bytes = format!(
            "{divider}\nFILE: {name} | FOLDER: Root | CREATED: x | MODIFIED: y\n{divider}\n\nhello "
        )
        .into_bytes();
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        bytes.extend_from_slice(b" world\n");
        fs::write(&backup_path, &bytes).unwrap();

        let result = restore_backup().expect("restore_backup should not fail on invalid UTF-8");
        assert_eq!(
            result.restored_count, 1,
            "the readable note must be restored: {result:?}"
        );
        let restored_path = get_notes_dir().join(&name);
        assert!(restored_path.is_file(), "restored note must exist on disk");
        let _ = fs::remove_file(&restored_path);

        // Put the original backup back.
        if let Some(bytes) = original {
            let _ = fs::write(&backup_path, bytes);
        } else {
            let _ = fs::remove_file(&backup_path);
        }
    }
}
