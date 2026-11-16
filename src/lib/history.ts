export interface HistorySnapshot {
  content: string;
  cursor: number;
}

/**
 * Burst-aware undo/redo for the editor textarea.
 *
 * Typing bursts (<700ms between keystrokes) coalesce into a single undo
 * step. Structural edits — newline, an insertion or deletion of more than
 * 50 characters, and cursor-relative multi-character changes — always
 * create a fresh checkpoint, as do explicit `isForceNewStep` callers
 * (Tab, cut/paste).
 */
export class EditorHistoryManager {
  private past: HistorySnapshot[] = [];
  private present: HistorySnapshot;
  private future: HistorySnapshot[] = [];
  private lastInputTime = 0;
  private readonly maxDepth = 150;
  private readonly burstThresholdMs = 700;

  constructor(initialContent = '', initialCursor = 0) {
    this.present = { content: initialContent, cursor: initialCursor };
    this.lastInputTime = Date.now();
  }

  /** Reset history for a newly opened note. */
  reset(content: string, cursor = 0) {
    this.past = [];
    this.present = { content, cursor };
    this.future = [];
    this.lastInputTime = Date.now();
  }

  record(newContent: string, newCursor: number, isForceNewStep = false): void {
    if (newContent === this.present.content) {
      this.present = { content: newContent, cursor: newCursor };
      return;
    }

    const now = Date.now();
    const timeDelta = now - this.lastInputTime;
    const isBurst = !isForceNewStep && timeDelta < this.burstThresholdMs;

    // Detect a newline anywhere in the changed region (works for backward
    // moves, deletions, and paste): compare via common prefix/suffix so the
    // cursor direction never matters.
    const prev = this.present.content;
    let prefix = 0;
    const minLen = Math.min(prev.length, newContent.length);
    while (prefix < minLen && prev[prefix] === newContent[prefix]) prefix++;
    let prevSuffix = prev.length;
    let newSuffix = newContent.length;
    while (prevSuffix > prefix && newSuffix > prefix && prev[prevSuffix - 1] === newContent[newSuffix - 1]) {
      prevSuffix--;
      newSuffix--;
    }
    const inserted = newContent.slice(prefix, newSuffix);
    const deleted = prev.slice(prefix, prevSuffix);
    const isNewline = inserted.includes('\n') || deleted.includes('\n');

    // A paste is sized by what it inserts or deletes, not by the net length
    // change: pasting 60 characters over a 60-character selection changes
    // the total length by 0 but is still a paste, and must break coalescing.
    const isPasteLike = inserted.length > 50 || deleted.length > 50;

    if (isBurst && !isNewline && !isPasteLike && this.past.length > 0) {
      this.present = { content: newContent, cursor: newCursor };
      this.future = [];
    } else {
      this.past.push({ ...this.present });
      if (this.past.length > this.maxDepth) {
        this.past.splice(0, this.past.length - this.maxDepth);
      }
      this.present = { content: newContent, cursor: newCursor };
      this.future = [];
    }
    this.lastInputTime = now;
  }

  undo(): HistorySnapshot | null {
    if (this.past.length === 0) return null;
    const previous = this.past.pop()!;
    this.future.push({ ...this.present });
    this.present = previous;
    this.lastInputTime = 0;
    return { ...this.present };
  }

  redo(): HistorySnapshot | null {
    if (this.future.length === 0) return null;
    const next = this.future.pop()!;
    this.past.push({ ...this.present });
    this.present = next;
    this.lastInputTime = 0;
    return { ...this.present };
  }
}
