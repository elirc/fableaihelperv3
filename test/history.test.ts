// The renderer's pure state modules, extracted from app.ts so they can be
// tested without a DOM: createHistory (the Q/A entry list, live-entry
// lifecycle, view cursor, and MAX_HISTORY trimming) and stateUi (the per-state
// transport-control descriptor). app.ts is only glue over these — the DOM side
// of the same behavior is exercised end-to-end in test/app.test.ts.
import { describe, expect, test } from 'vitest';
import { createHistory, type History } from '../src/renderer/history';
import { stateUi, type State } from '../src/renderer/ui-state';
import { createDefaultProfile, resolveContext } from '../src/shared/context';
import type { SettingsView } from '../src/shared/types';

const MAX = 6; // mirrors MAX_HISTORY in app.ts

test('history captures independent nested context snapshots', () => {
  const settings: SettingsView = { resume: 'resume', jobDescription: 'role', alwaysOnTop: false, llmProvider: 'anthropic', answerStyle: 'balanced', hotkey: '', hotkeyRegistered: false, hasDeepgramKey: false, hasAnthropicKey: false, hasGroqKey: false, contextProfiles: [createDefaultProfile()] };
  const context = resolveContext(settings, { followUp: { question: 'Selected question', answer: 'AI suggestion' } });
  const history = createHistory(MAX);
  const first = history.beginLive(context);
  context.output.tone = 'diplomatic';
  context.relatedAnswer!.answer = 'Changed suggestion';
  const second = history.beginLive(context);
  expect(first.context?.output.tone).toBe('confident');
  expect(first.context?.relatedAnswer?.answer).toBe('AI suggestion');
  expect(second.context?.output.tone).toBe('diplomatic');
  second.context!.relatedAnswer!.question = 'New question';
  expect(first.context?.relatedAnswer?.question).toBe('Selected question');
});

/** Complete one Q/A cycle the way llm:done does: begin, fill, retire in place. */
function addCompleted(h: History, question: string, answer = `answer to ${question}`): void {
  const e = h.beginLive();
  e.question = question;
  e.answer = answer;
  e.live = false;
}

describe('createHistory — empty state', () => {
  test('starts empty: no entries, cursor at -1, nothing viewed or live', () => {
    const h = createHistory(MAX);
    expect(h.count()).toBe(0);
    expect(h.viewIndex()).toBe(-1);
    expect(h.viewed()).toBeUndefined();
    expect(h.live()).toBeUndefined();
    expect(h.viewingLive()).toBe(false);
  });

  test('prev/next/dropLive on an empty history are refused no-ops', () => {
    const h = createHistory(MAX);
    expect(h.prev()).toBe(false);
    expect(h.next()).toBe(false);
    expect(h.dropLive()).toBe(false);
    expect(h.count()).toBe(0);
    expect(h.viewIndex()).toBe(-1);
  });
});

describe('createHistory — live entry lifecycle', () => {
  test('beginLive pushes an empty live entry and moves the cursor to it', () => {
    const h = createHistory(MAX);
    const e = h.beginLive();
    expect(e).toEqual({ question: '', answer: '', metrics: null, live: true });
    expect(h.count()).toBe(1);
    expect(h.viewIndex()).toBe(0);
    expect(h.viewed()).toBe(e);
    expect(h.live()).toBe(e);
    expect(h.viewingLive()).toBe(true);
  });

  test('mutations through live() are visible through viewed() — same object', () => {
    // Session handlers write through live() while renderEntry reads through
    // viewed(); the contract is one shared object, not a copy.
    const h = createHistory(MAX);
    h.beginLive();
    h.live()!.question = 'What is TCP?';
    h.live()!.answer += 'A protocol.';
    expect(h.viewed()).toMatchObject({ question: 'What is TCP?', answer: 'A protocol.' });
  });

  test('live() returns undefined once the newest entry is retired', () => {
    const h = createHistory(MAX);
    const e = h.beginLive();
    e.question = 'q';
    expect(h.dropLive()).toBe(true);
    expect(e.live).toBe(false);
    expect(h.live()).toBeUndefined();
    expect(h.viewed()).toBe(e); // the entry itself survives
  });

  test('dropLive discards an entry that captured nothing', () => {
    const h = createHistory(MAX);
    h.beginLive();
    expect(h.dropLive()).toBe(true);
    expect(h.count()).toBe(0);
    expect(h.viewIndex()).toBe(-1);
  });

  test('whitespace-only capture still counts as nothing', () => {
    const h = createHistory(MAX);
    const e = h.beginLive();
    e.question = '  \n ';
    e.answer = ' \t';
    h.dropLive();
    expect(h.count()).toBe(0);
  });

  test('a question alone is enough to retire instead of discard', () => {
    const h = createHistory(MAX);
    h.beginLive().question = 'heard this much';
    h.dropLive();
    expect(h.count()).toBe(1);
    expect(h.viewed()).toMatchObject({ question: 'heard this much', live: false });
  });

  test('an answer alone is enough to retire instead of discard', () => {
    // An llm:delta can land before any stt text does on the ask path.
    const h = createHistory(MAX);
    h.beginLive().answer = 'half an answer';
    h.dropLive();
    expect(h.count()).toBe(1);
    expect(h.viewed()).toMatchObject({ answer: 'half an answer', live: false });
  });

  test('dropLive is refused when the newest entry is already retired', () => {
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    expect(h.dropLive()).toBe(false);
    expect(h.count()).toBe(1);
  });

  test('dropLive keeps the cursor where the user navigated back to', () => {
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    addCompleted(h, 'q2');
    h.beginLive();
    h.prev();
    h.prev(); // reading q1 while a new recording spins up
    h.dropLive(); // the recording failed with nothing captured
    expect(h.count()).toBe(2);
    expect(h.viewIndex()).toBe(0);
    expect(h.viewed()?.question).toBe('q1');
  });

  test('dropLive pulls the cursor in when the discarded entry was the one viewed', () => {
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    addCompleted(h, 'q2');
    h.beginLive(); // cursor follows to index 2
    h.dropLive();
    expect(h.viewIndex()).toBe(1);
    expect(h.viewed()?.question).toBe('q2');
  });

  test('beginLive over a still-streaming entry abandons it in place', () => {
    // Asking while an answer streams begins a new live entry without retiring
    // the old one: its session events are filtered by id, so the stale `live`
    // flag is unreachable through live() and harmless.
    const h = createHistory(MAX);
    const a = h.beginLive();
    a.question = 'first question';
    a.answer = 'streaming ans';
    const b = h.beginLive();
    expect(h.count()).toBe(2);
    expect(h.live()).toBe(b);
    expect(a.live).toBe(true); // never retired — just no longer the last entry
    h.prev();
    expect(h.viewed()).toBe(a);
  });

  test('discarding an empty live entry re-exposes a still-live entry beneath it', () => {
    // The abandoned-entry quirk above, one step further: dropping the empty
    // newcomer makes the abandoned entry the last again, so live() finds it.
    // Its session is long gone, so nothing will write to it — but dropLive
    // could now retire it, which is exactly what onSessionError needs.
    const h = createHistory(MAX);
    const a = h.beginLive();
    a.question = 'abandoned mid-stream';
    h.beginLive();
    h.dropLive(); // the newcomer captured nothing
    expect(h.count()).toBe(1);
    expect(h.live()).toBe(a);
  });
});

describe('createHistory — trimming to capacity', () => {
  test('the list never grows past maxEntries; the oldest entry falls off', () => {
    const h = createHistory(MAX);
    for (let i = 1; i <= MAX + 1; i += 1) addCompleted(h, `q${i}`);
    expect(h.count()).toBe(MAX);
    while (h.prev()) {
      /* walk to the front */
    }
    expect(h.viewed()?.question).toBe('q2'); // q1 was trimmed away
  });

  test('the trim happens on beginLive and the new live entry always survives it', () => {
    // The slice keeps the *last* maxEntries, and the live entry was just
    // pushed at the end — so trimming can never evict the recording in flight.
    const h = createHistory(MAX);
    for (let i = 1; i <= MAX; i += 1) addCompleted(h, `q${i}`);
    const live = h.beginLive();
    expect(h.count()).toBe(MAX);
    expect(h.live()).toBe(live);
    expect(h.viewed()).toBe(live);
    expect(h.viewIndex()).toBe(MAX - 1);
  });

  test('a still-live abandoned entry is trimmed away like any other', () => {
    const h = createHistory(MAX);
    const abandoned = h.beginLive();
    abandoned.question = 'left streaming forever';
    for (let i = 1; i <= MAX; i += 1) addCompleted(h, `q${i}`);
    expect(h.count()).toBe(MAX);
    while (h.prev()) {
      /* walk to the front */
    }
    expect(h.viewed()?.question).toBe('q1'); // the abandoned entry is gone
  });

  test('a trimming beginLive yanks the cursor from the front to the live entry', () => {
    // beginLive always views the new entry; combined with the trim, a user
    // reading the oldest answer is moved to the fresh recording, not left
    // pointing at an index whose entry just changed identity.
    const h = createHistory(MAX);
    for (let i = 1; i <= MAX; i += 1) addCompleted(h, `q${i}`);
    while (h.prev()) {
      /* reading q1 */
    }
    const live = h.beginLive();
    expect(h.viewIndex()).toBe(MAX - 1);
    expect(h.viewed()).toBe(live);
  });

  test('a small maxEntries is honoured', () => {
    const h = createHistory(2);
    addCompleted(h, 'q1');
    addCompleted(h, 'q2');
    addCompleted(h, 'q3');
    expect(h.count()).toBe(2);
    h.prev();
    expect(h.viewed()?.question).toBe('q2');
  });
});

describe('createHistory — navigation', () => {
  test('prev/next walk the cursor and report whether they moved', () => {
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    addCompleted(h, 'q2');
    addCompleted(h, 'q3');
    expect(h.viewIndex()).toBe(2);
    expect(h.next()).toBe(false); // already at the newest
    expect(h.prev()).toBe(true);
    expect(h.viewed()?.question).toBe('q2');
    expect(h.prev()).toBe(true);
    expect(h.prev()).toBe(false); // already at the oldest
    expect(h.viewed()?.question).toBe('q1');
    expect(h.next()).toBe(true);
    expect(h.viewIndex()).toBe(1);
  });

  test('viewingLive is about position, not liveness', () => {
    // The name means "viewing the newest slot": renderEntry uses it to decide
    // where the live/generating tags belong, even after the entry retired.
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    addCompleted(h, 'q2');
    expect(h.live()).toBeUndefined();
    expect(h.viewingLive()).toBe(true);
    h.prev();
    expect(h.viewingLive()).toBe(false);
    h.next();
    expect(h.viewingLive()).toBe(true);
  });
});

describe('createHistory — clear', () => {
  test('clear empties everything', () => {
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    h.beginLive();
    h.clear();
    expect(h.count()).toBe(0);
    expect(h.viewIndex()).toBe(-1);
    expect(h.viewed()).toBeUndefined();
    expect(h.live()).toBeUndefined();
  });

  test('the history is usable again after clear', () => {
    const h = createHistory(MAX);
    addCompleted(h, 'q1');
    h.clear();
    const e = h.beginLive();
    expect(h.count()).toBe(1);
    expect(h.viewIndex()).toBe(0);
    expect(h.viewed()).toBe(e);
    expect(h.viewingLive()).toBe(true);
  });
});

describe('stateUi', () => {
  test('idle shows the caller-supplied ready text and unlocks the ask box', () => {
    expect(stateUi('idle', 'Ready — press Record or Ctrl+Shift+Space')).toEqual({
      recordLabel: 'Record',
      dotClass: 'dot',
      statusText: 'Ready — press Record or Ctrl+Shift+Space',
      askLocked: false,
    });
  });

  test.each([
    ['starting', 'Starting…', 'dot busy', 'Opening the microphone feed…', true],
    ['recording', 'Stop & Answer', 'dot recording', 'Recording call audio…', true],
    ['finalizing', 'Record', 'dot busy', 'Finalizing transcript…', true],
    ['answering', 'Record', 'dot busy', 'Generating answer…', false],
  ] as const)(
    '%s maps to its fixed label, dot and status',
    (state, recordLabel, dotClass, statusText, askLocked) => {
      expect(stateUi(state, 'unused ready text')).toEqual({
        recordLabel,
        dotClass,
        statusText,
        askLocked,
      });
    },
  );

  test('the ask box is locked exactly while audio capture is in any stage of flight', () => {
    // Answering deliberately stays unlocked: asking over a streaming answer
    // aborts the old session, but audio capture must never be double-driven.
    const locked = (['starting', 'recording', 'finalizing'] as const).map(
      (s: State) => stateUi(s, 'r').askLocked,
    );
    const unlocked = (['idle', 'answering'] as const).map((s: State) => stateUi(s, 'r').askLocked);
    expect(locked).toEqual([true, true, true]);
    expect(unlocked).toEqual([false, false]);
  });
});
