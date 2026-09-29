// Q/A history for the renderer: the entry list, the live (in-progress) entry,
// and the view cursor. Pure state, no DOM — app.ts renders from this, and the
// logic is unit-testable in a plain node environment (test/history.test.ts).

import type { AnswerMetrics, ContextSnapshot } from '../shared/types';
import { cloneContext } from '../shared/context';

/** One question/answer pair. `live` marks the entry still receiving events. */
export interface Entry {
  question: string;
  answer: string;
  metrics: AnswerMetrics | null;
  live: boolean;
  context?: ContextSnapshot;
}

export interface History {
  count(): number;
  /** Cursor into the list; -1 when the history is empty. */
  viewIndex(): number;
  /** The entry under the cursor, if any. */
  viewed(): Entry | undefined;
  /** True when the cursor sits on the newest entry, live or not. */
  viewingLive(): boolean;
  /** The newest entry, only while it is still live. */
  live(): Entry | undefined;
  /** Push a fresh live entry, trim to capacity, and move the cursor to it. */
  beginLive(context?: ContextSnapshot): Entry;
  /**
   * Retire the live entry; discard it only when it captured nothing at all.
   * Returns false when the newest entry was not live (nothing to do).
   */
  dropLive(): boolean;
  /** Move the cursor one entry back/forward; false when already at that end. */
  prev(): boolean;
  next(): boolean;
  clear(): void;
}

export function createHistory(maxEntries: number): History {
  let entries: Entry[] = [];
  let viewIndex = -1;

  return {
    count: () => entries.length,
    viewIndex: () => viewIndex,
    viewed: () => entries[viewIndex],
    viewingLive: () => entries.length > 0 && viewIndex === entries.length - 1,

    // Only the *last* entry can be the live one: a begin over a still-live
    // entry (ask while an answer streams) abandons the older entry in place —
    // its session events are already filtered out by session id, so nothing
    // will ever write to it again.
    live: () => {
      const last = entries[entries.length - 1];
      return last?.live ? last : undefined;
    },

    beginLive(context?: ContextSnapshot): Entry {
      const entry: Entry = { question: '', answer: '', metrics: null, live: true, ...(context ? { context: cloneContext(context) } : {}) };
      entries.push(entry);
      if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);
      viewIndex = entries.length - 1;
      return entry;
    },

    dropLive(): boolean {
      const idx = entries.length - 1;
      const e = entries[idx];
      if (!e?.live) return false;
      if (e.question.trim() === '' && e.answer.trim() === '') entries.splice(idx, 1);
      else e.live = false;
      // Keep the user's place when they had navigated back; only pull the
      // cursor in when the discarded entry was the one being viewed.
      viewIndex = Math.min(viewIndex, entries.length - 1);
      return true;
    },

    prev(): boolean {
      if (viewIndex <= 0) return false;
      viewIndex -= 1;
      return true;
    },
    next(): boolean {
      if (viewIndex >= entries.length - 1) return false;
      viewIndex += 1;
      return true;
    },

    clear(): void {
      entries = [];
      viewIndex = -1;
    },
  };
}
