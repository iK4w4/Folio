<p align="center">
  <img src="src-tauri/icons/icon-1024.png" width="120" alt="Folio icon">
</p>

<h1 align="center">Folio</h1>

<p align="center">
  A small, fast, portable notes app for Windows.<br>
  Notes are plain Markdown files on disk — no accounts, no cloud, no lock-in.<br>
  If the app ever goes away, your notes stay readable.
</p>

<p align="center">
  <a href="https://github.com/iK4w4/Folio/releases"><img src="https://img.shields.io/github/v/release/iK4w4/Folio" alt="Release"></a>
  <img src="https://img.shields.io/badge/platform-Windows_10_%2F_11-333" alt="Platform">
  <img src="https://img.shields.io/badge/built_with-Tauri_2_·_Rust_·_React-007ec6" alt="Built with">
  <img src="https://img.shields.io/badge/download_size-~4.6_MB-brightgreen" alt="Download size">
  <img src="https://img.shields.io/badge/license-MIT-333" alt="License">
</p>

<p align="center">
  <a href="https://www.youtube.com/@iK4w4"><img src="https://img.shields.io/badge/YouTube-@iK4w4-FF0000?logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://t.me/iK4w4"><img src="https://img.shields.io/badge/Telegram-@iK4w4-26A5E4?logo=telegram&logoColor=white" alt="Telegram"></a>
  <a href="https://t.me/AskKawaBot"><img src="https://img.shields.io/badge/Telegram_Bot-@AskKawaBot-26A5E4?logo=telegram&logoColor=white" alt="Telegram Bot"></a>
</p>

## Screenshots

![Folio in Light mode, Split view](screenshots/light-white.png)
*Light mode — Mist Slate, Split view with live preview*

![Folio in Light mode, Preferences open](screenshots/light-blue.png)
*Light mode — Royal Blue, Preferences with the sixteen palettes*

## Download

Grab `Folio.exe` from the [Releases](https://github.com/iK4w4/Folio/releases) page. One portable file — drop it in any folder or on a USB drive and run it. Everything it needs lives next to the exe.


## Features

- **No titles.** A note has no title field — the first line *is* the note. Files are named from the date, a slug of the first words (Persian, Arabic, Cyrillic, CJK, and Latin all work), and a random suffix so names never collide.
- **Instant autosave.** 500 ms after every keystroke, flushed immediately on blur, note switch, or window close — the last keystrokes are never dropped.
- **Undo/redo that survives autosave.** Typing bursts coalesce into one undo step, and saving never resets the stack.
- **Folders.** Real subdirectories under `Notes/`. Drag a note onto a folder to move it.
- **One way per action.** Pin, move, duplicate, export, and trash live in the note's right-click menu and the editor's "⋯" menu.
- **Search & sort.** Live search over the first line and body. Sort by Created, Newest, Oldest, or A–Z.
- **One backup file.** `All Notes.txt` lives next to the exe, rewritten atomically after every change. "Restore Missing from Backup" re-imports notes that are gone from disk without overwriting anything that exists.
- **Liquid glass & themes.** Dark (default) and Light mode, sixteen color palettes, zoom 90–150%.
- **Formatting toolbar.** Bold, italic, strikethrough, code, headings, lists, quote, code block, link, image, divider — Ctrl+B/I/K included.
- **Single instance.** Launching Folio again focuses the running window instead of opening a second copy that could overwrite your notes.
- **100% offline & private.** No accounts, no cloud, no tracking, no network calls.

## Where your data lives

Everything sits next to the exe — the app is fully portable:

```
Folio.exe
Notes/            <- your notes, plain .md files, folders as subdirectories
settings.json     <- theme, palette, zoom, font, glassiness
pins.json         <- pinned notes
folders.json      <- folder registry
trash.json        <- trash registry
Trash/            <- soft-deleted notes (restorable)
All Notes.txt     <- the whole collection, rewritten after every change
```

## Build from source

Prerequisites: Node.js 18+, the Rust toolchain (stable, MSVC), and WebView2 (preinstalled on Windows 10/11).

```bash
npm install
npm run tauri build
```

Or step by step:

```bash
npm install
npm run build        # frontend -> dist/
cd src-tauri
cargo build --release
```

Output: `src-tauri/target/release/folio.exe`. Cross-compiling from Linux works with `cargo-xwin`: `cargo xwin build --release --target x86_64-pc-windows-msvc`.

## Security

Folio is fully offline and stores everything as plain files you own. See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Credits

Created by **iK4w4**
Support: [Telegram @AskKawaBot](https://t.me/AskKawaBot)
