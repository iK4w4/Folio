# Changelog

All notable changes to Folio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.14] - 2026-11-16

First public release.

### Included

- Portable single exe — notes, settings, pins, trash, and the backup file
  all live next to it; nothing is installed and nothing leaves the machine
- Notes as plain Markdown files; the first line is the note, files are
  named from the date, a slug of the first words (Persian, Arabic,
  Cyrillic, CJK, and Latin), and a random suffix
- Instant autosave (500 ms debounce, flushed on blur, note switch, and
  window close) with undo/redo that survives saves
- Folders as real subdirectories, drag-and-drop move, pin, duplicate,
  export, trash with restore
- Live search, sort by Created / Newest / Oldest / A–Z
- One-file backup (`All Notes.txt`) rewritten after every change, with
  restore of missing notes that never overwrites existing ones
- Liquid-glass UI, Dark and Light modes, 16 color palettes, zoom 90–150%
- Single-instance: launching Folio again focuses the running window
  instead of opening a second copy that could overwrite your notes
- Preview task checkboxes flip the exact source line they render,
  including ordered-list and blockquote tasks
