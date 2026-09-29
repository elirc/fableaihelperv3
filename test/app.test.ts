// @vitest-environment happy-dom
//
// Drives the REAL app.ts against the REAL index.html markup: the body of the
// page is loaded into happy-dom, `window.api` is a mocked preload bridge whose
// event callbacks are captured so tests can fire stt/llm/error events, and the
// module is re-imported per test (it has top-level side effects). Audio capture
// is stubbed at the getDisplayMedia/AudioContext boundary — close enough to
// drive the full record → stop → answer cycle, including the frame-buffering
// window while the session opens. Every assertion is on real DOM state
// (textContent, hidden, disabled, aria attributes), never on internals.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_HOTKEY } from '../src/shared/types';
import { createDefaultProfile, createProfile, CONTEXT_LIMITS } from '../src/shared/context';
import type {
  AnswerMetrics,
  LlmDeltaEvent,
  LlmDoneEvent,
  RendererApi,
  Result,
  SessionErrorEvent,
  SettingsPatch,
  SettingsView,
  AnswerOptions,
  SttPartialEvent,
} from '../src/shared/types';

// ---------- page ----------
// cwd-relative because import.meta.url is an http: URL under happy-dom.
const pageHtml = readFileSync(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8');
// The markup between <body> tags, minus the module script (vitest imports the
// real app.ts itself; a stray <script src> would 404 inside happy-dom).
const bodyHtml = pageHtml
  .slice(pageHtml.indexOf('<body>') + '<body>'.length, pageHtml.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`markup is missing #${id}`);
  return found as T;
};
const statusLine = (): string => el('statusText').textContent ?? '';

const BASE_READY = 'Ready — press Record while your practice partner asks a question';
const HOTKEY_READY = 'Ready — press Record or Ctrl+Shift+Space';
const ANSWER_PLACEHOLDER = 'The model answer to practise against will stream here.';
const TRANSCRIPT_PLACEHOLDER = 'The live transcript will appear here while you record.';

// ---------- async helpers ----------
/** One macrotask: lets every pending microtask chain (awaits) settle first. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** One paint: scheduleRender coalesces stream updates onto animation frames. */
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------- bridge mock ----------
const metrics = (over: Partial<AnswerMetrics> = {}): AnswerMetrics => ({
  sttFinalizeMs: 120,
  firstTokenMs: 420,
  totalMs: 1800,
  ...over,
});

function makeSettings(over: Partial<SettingsView> = {}): SettingsView {
  return {
    resume: 'a resume',
    jobDescription: 'a job description',
    alwaysOnTop: false,
    llmProvider: 'anthropic',
    answerStyle: 'balanced',
    hotkey: DEFAULT_HOTKEY,
    hotkeyRegistered: true,
    hasDeepgramKey: true,
    hasAnthropicKey: true,
    hasGroqKey: false,
    ...over,
  };
}

/** The event callbacks app.ts registered, so tests can play the main process. */
interface Fired {
  sttPartial(e: SttPartialEvent): void;
  llmDelta(e: LlmDeltaEvent): void;
  llmDone(e: LlmDoneEvent): void;
  sessionError(e: SessionErrorEvent): void;
  hotkey(): void;
}

function makeApi(settings: SettingsView) {
  const unregistered = (name: string) => (): never => {
    throw new Error(`app never registered ${name}`);
  };
  const fire: Fired = {
    sttPartial: unregistered('onSttPartial'),
    llmDelta: unregistered('onLlmDelta'),
    llmDone: unregistered('onLlmDone'),
    sessionError: unregistered('onSessionError'),
    hotkey: unregistered('onHotkeyToggle'),
  };
  const api = {
    getSettings: vi.fn(async (): Promise<SettingsView> => settings),
    saveSettings: vi.fn(async (_patch: SettingsPatch): Promise<SettingsView> => settings),
    startSession: vi.fn(async (_options?: AnswerOptions): Promise<Result<number>> => ({ ok: true, value: 1 })),
    askQuestion: vi.fn(async (_text: string, _options?: AnswerOptions): Promise<Result<number>> => ({ ok: true, value: 1 })),
    sendAudio: vi.fn((_sessionId: number, _pcm: ArrayBuffer): void => {}),
    stopSession: vi.fn(async (_sessionId: number): Promise<Result<null>> => ({ ok: true, value: null })),
    cancelSession: vi.fn(async (_sessionId: number): Promise<void> => {}),
    onSttPartial: vi.fn((cb: (e: SttPartialEvent) => void) => {
      fire.sttPartial = cb;
      return () => {};
    }),
    onLlmDelta: vi.fn((cb: (e: LlmDeltaEvent) => void) => {
      fire.llmDelta = cb;
      return () => {};
    }),
    onLlmDone: vi.fn((cb: (e: LlmDoneEvent) => void) => {
      fire.llmDone = cb;
      return () => {};
    }),
    onSessionError: vi.fn((cb: (e: SessionErrorEvent) => void) => {
      fire.sessionError = cb;
      return () => {};
    }),
    onHotkeyToggle: vi.fn((cb: () => void) => {
      fire.hotkey = cb;
      return () => {};
    }),
  };
  return { api, fire };
}
type ApiMock = ReturnType<typeof makeApi>['api'];

// ---------- capture stubs ----------
interface CaptureStub {
  audioTrack: { stop: ReturnType<typeof vi.fn>; kind: string };
  worklets: Array<{
    port: { onmessage: ((e: { data: { pcm: ArrayBuffer; rms: number } }) => void) | null };
  }>;
  /** Lets a test hold getDisplayMedia open and release it later (defer: true). */
  releaseDisplayMedia: () => void;
}

/** Fakes just enough of getDisplayMedia + Web Audio for startCapture to run. */
function stubCapture(opts: { defer?: boolean } = {}): CaptureStub {
  const audioTrack = { stop: vi.fn(), kind: 'audio' };
  const stream = {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [] as Array<{ stop(): void }>,
    getTracks: () => [audioTrack],
  };
  const gate = deferred<void>();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        if (opts.defer) await gate.promise;
        return stream as unknown as MediaStream;
      }),
      getDisplayMedia: vi.fn(async () => {
        if (opts.defer) await gate.promise;
        return stream as unknown as MediaStream;
      }),
    },
  });
  const worklets: CaptureStub['worklets'] = [];
  vi.stubGlobal('MediaStream', class {});
  vi.stubGlobal(
    'AudioContext',
    class {
      audioWorklet = { addModule: async (_url: string): Promise<void> => {} };
      createMediaStreamSource(_s: unknown) {
        return { connect: (_n: unknown): void => {} };
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port: CaptureStub['worklets'][number]['port'] = { onmessage: null };
      constructor(_ctx: unknown, _name: string, _opts?: unknown) {
        worklets.push(this);
      }
    },
  );
  return { audioTrack, worklets, releaseDisplayMedia: gate.resolve };
}

// ---------- boot ----------
interface Booted {
  api: ApiMock;
  fire: Fired;
  settings: SettingsView;
}

/**
 * Fresh page + fresh module per test: app.ts wires everything at import time,
 * so each test re-imports it against a rebuilt body and a new bridge mock.
 * `mutate` runs before the import for tests that need boot-time api behavior.
 */
async function boot(
  over: Partial<SettingsView> = {},
  mutate?: (api: ApiMock) => void,
): Promise<Booted> {
  document.body.innerHTML = bodyHtml;
  const settings = makeSettings(over);
  const { api, fire } = makeApi(settings);
  mutate?.(api);
  (window as unknown as { api: RendererApi }).api = api;
  vi.resetModules();
  await import('../src/renderer/app');
  await flush(); // the first-run getSettings nudge settles
  return { api, fire, settings };
}

function submitAsk(text: string): void {
  el<HTMLInputElement>('askInput').value = text;
  el<HTMLFormElement>('askForm').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
}

/** One full typed-question cycle, the way the main process would answer it. */
async function completeAsk(fire: Fired, question: string, answer: string, id = 1): Promise<void> {
  submitAsk(question);
  await flush();
  fire.llmDone({ sessionId: id, transcript: question, answer, metrics: metrics() });
  await flush();
}

const pressEscape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
};

let clipboardWrite: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clipboardWrite = vi.fn(async (_text: string): Promise<void> => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  // Default: capture is unavailable. Tests that record call stubCapture().
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async (): Promise<MediaStream> => { throw new Error('Capture denied by test'); }),
      getDisplayMedia: vi.fn(async (): Promise<MediaStream> => {
        throw new Error('Capture denied by test');
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- tests ----------

describe('boot', () => {
  test('wires the hotkey hint and ready text from settings', async () => {
    await boot();
    expect(statusLine()).toBe(HOTKEY_READY);
    expect(el('hotkeyHint').hidden).toBe(false);
    expect(el('hotkeyHint').textContent).toBe('Ctrl+Shift+Space');
    expect(el('hotkeyWarn').hidden).toBe(true);
    expect(el('errorBox').hidden).toBe(true);
  });

  test('first run without a Deepgram key nudges toward Settings', async () => {
    await boot({ hasDeepgramKey: false });
    expect(statusLine()).toContain('Settings');
  });

  test('a missing key for the selected LLM provider also nudges', async () => {
    await boot({ llmProvider: 'groq', hasGroqKey: false, hasAnthropicKey: true });
    expect(statusLine()).toContain('Settings');
  });

  test('no nudge when the selected provider has its key, even if the other is missing', async () => {
    await boot({ llmProvider: 'groq', hasGroqKey: true, hasAnthropicKey: false });
    expect(statusLine()).toBe(HOTKEY_READY);
  });

  test('a taken hotkey shows the warning and drops it from the ready text', async () => {
    await boot({ hotkeyRegistered: false });
    expect(el('hotkeyWarn').hidden).toBe(false);
    expect(el('hotkeyWarn').textContent).toContain('already taken');
    expect(el('hotkeyHint').hidden).toBe(true);
    expect(statusLine()).toBe(BASE_READY);
  });

  test('a failing getSettings at boot lands in the error box', async () => {
    await boot({}, (api) => api.getSettings.mockRejectedValue(new Error('bridge down')));
    expect(el('errorBox').hidden).toBe(false);
    expect(el('errorBox').textContent).toBe('bridge down');
  });

  test('style chips reflect the persisted answer style', async () => {
    await boot({ answerStyle: 'detailed' });
    expect(el('styleDetailed').getAttribute('aria-pressed')).toBe('true');
    expect(el('styleBrief').getAttribute('aria-pressed')).toBe('false');
    expect(el('styleBalanced').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ask flow', () => {
  test('a typed question flows end to end: ask → stream → done', async () => {
    const { api, fire } = await boot();
    submitAsk('  What is TCP?  ');
    await flush();

    // The trimmed text went out, the UI claimed the answering state, and the
    // question is on screen before any event has come back.
    expect(api.askQuestion).toHaveBeenCalledWith('What is TCP?', expect.objectContaining({ snapshot: expect.objectContaining({ profileName: 'Interview' }) }));
    expect(statusLine()).toBe('Generating answer…');
    expect(el('genTag').hidden).toBe(false);
    expect(el('transcriptBox').textContent).toBe('What is TCP?');
    expect(el('answerBox').getAttribute('aria-busy')).toBe('true');
    expect(el<HTMLInputElement>('askInput').value).toBe(''); // cleared on accept
    expect(el('regenBtn').hidden).toBe(false); // re-ask is legal mid-answer

    fire.sttPartial({ sessionId: 1, text: 'What is TCP, really?', isFinal: true });
    fire.llmDelta({ sessionId: 1, delta: 'It is a **reliable**' });
    fire.llmDelta({ sessionId: 1, delta: ' transport protocol.' });
    await frame();
    expect(el('transcriptBox').textContent).toBe('What is TCP, really?');
    expect(el('answerBox').querySelector('strong')?.textContent).toBe('reliable');

    fire.llmDone({
      sessionId: 1,
      transcript: 'What is TCP, really?',
      answer: 'It is a **reliable** transport protocol.',
      metrics: metrics(),
    });
    expect(statusLine()).toBe('Done — press Record for the next question');
    expect(el('transcriptBox').textContent).toBe('What is TCP, really?');
    expect(el('answerBox').textContent).toBe('It is a reliable transport protocol.');
    expect(el('latencyTag').hidden).toBe(false);
    expect(el('latencyTag').textContent).toBe('0.4s to first token received');
    expect(el('latencyTag').title).toContain('420 ms');
    expect(el('genTag').hidden).toBe(true);
    expect(el('answerBox').getAttribute('aria-busy')).toBe('false');
    expect(el('copyBtn').hidden).toBe(false);
    expect(el<HTMLInputElement>('askInput').disabled).toBe(false);
  });

  test('empty or whitespace input never reaches the bridge', async () => {
    const { api } = await boot();
    submitAsk('   ');
    await flush();
    expect(api.askQuestion).not.toHaveBeenCalled();
    expect(statusLine()).toBe(HOTKEY_READY); // still idle
  });

  test('events for a stale session change nothing', async () => {
    const { fire } = await boot();
    submitAsk('Q');
    await flush();

    fire.sttPartial({ sessionId: 99, text: 'WRONG QUESTION', isFinal: true });
    fire.llmDelta({ sessionId: 99, delta: 'WRONG ANSWER' });
    fire.llmDone({ sessionId: 99, transcript: 'W', answer: 'W', metrics: metrics() });
    fire.sessionError({ sessionId: 99, error: { code: 'stt_error', message: 'WRONG ERROR' } });
    await frame();

    expect(el('transcriptBox').textContent).toBe('Q');
    expect(el('answerBox').textContent).toBe(ANSWER_PLACEHOLDER);
    expect(statusLine()).toBe('Generating answer…'); // the done/error were dropped too
    expect(el('errorBox').hidden).toBe(true);

    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A', metrics: metrics() });
  });

  test('events arriving before askQuestion resolves are buffered until its session id is known', async () => {
    const { api, fire } = await boot();
    const gate = deferred<Result<number>>();
    api.askQuestion.mockImplementationOnce(() => gate.promise);
    submitAsk('Q');
    await flush();

    // No session id has been adopted yet, so even "correct-id" events are stale.
    fire.llmDelta({ sessionId: 1, delta: 'too early' });
    await frame();
    expect(el('answerBox').textContent).toBe(ANSWER_PLACEHOLDER);

    gate.resolve({ ok: true, value: 1 });
    await flush();
    fire.llmDelta({ sessionId: 1, delta: 'on time' });
    await frame();
    expect(el('answerBox').textContent).toBe('too earlyon time');

    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'on time', metrics: metrics() });
  });

  test('a rejected askQuestion surfaces the error and retires the question', async () => {
    const { api } = await boot();
    api.askQuestion.mockRejectedValueOnce(new Error('ipc dead'));
    submitAsk('Q kept');
    await flush();

    expect(el('errorBox').hidden).toBe(false);
    expect(el('errorBox').textContent).toBe('ipc dead');
    expect(statusLine()).toBe(HOTKEY_READY); // back to idle
    // The entry captured a question, so it is retired — not discarded.
    expect(el('transcriptBox').textContent).toBe('Q kept');
    expect(el('copyBtn').hidden).toBe(true); // but there is no answer to copy
    expect(el('regenBtn').hidden).toBe(false); // and it can be re-asked
  });

  test('an ok:false askQuestion result shows the structured message and keeps the input', async () => {
    const { api } = await boot();
    api.askQuestion.mockResolvedValueOnce({
      ok: false,
      error: { code: 'no_llm_key', message: 'Add an API key in Settings' },
    });
    submitAsk('my question');
    await flush();

    expect(el('errorBox').textContent).toBe('Add an API key in Settings');
    expect(statusLine()).toBe(HOTKEY_READY);
    // The input is only cleared on acceptance; a failed ask keeps the text.
    expect(el<HTMLInputElement>('askInput').value).toBe('my question');
  });

  test('a session error mid-answer keeps the partial answer and shows the message', async () => {
    const { fire } = await boot();
    submitAsk('Q');
    await flush();
    fire.llmDelta({ sessionId: 1, delta: 'Half an ans' });
    await frame();

    fire.sessionError({ sessionId: 1, error: { code: 'llm_timeout', message: 'LLM fell over' } });
    expect(el('errorBox').hidden).toBe(false);
    expect(el('errorBox').textContent).toBe('LLM fell over');
    expect(statusLine()).toBe(HOTKEY_READY);
    // The entry had captured content, so it is retired with what it had.
    expect(el('transcriptBox').textContent).toBe('Q');
    expect(el('answerBox').textContent).toBe('Half an ans');
    expect(el('copyBtn').hidden).toBe(false); // the partial answer is copyable
  });

  test('asking over a streaming answer supersedes it cleanly', async () => {
    const { api, fire } = await boot();
    api.askQuestion
      .mockResolvedValueOnce({ ok: true, value: 1 })
      .mockResolvedValueOnce({ ok: true, value: 2 });
    submitAsk('Q1');
    await flush();
    fire.llmDelta({ sessionId: 1, delta: 'first answer streaming' });
    await frame();

    submitAsk('Q2');
    await flush();
    // A fresh live entry claimed the view; the old one is abandoned behind it.
    expect(el('transcriptBox').textContent).toBe('Q2');
    expect(el('answerBox').textContent).toBe(ANSWER_PLACEHOLDER);
    expect(el('historyLabel').textContent).toBe('2/2');

    // Stragglers from the superseded session are dead.
    fire.llmDelta({ sessionId: 1, delta: 'ZOMBIE' });
    await frame();
    expect(el('answerBox').textContent).toBe(ANSWER_PLACEHOLDER);

    fire.llmDone({ sessionId: 2, transcript: 'Q2', answer: 'A2', metrics: metrics() });
    expect(el('answerBox').textContent).toBe('A2');
    expect(statusLine()).toBe('Done — press Record for the next question');
  });

  test('the ask box is locked while capture spins up, and a locked submit is refused', async () => {
    const { api } = await boot();
    stubCapture({ defer: true }); // getDisplayMedia never resolves until released
    el('recordBtn').click();
    await flush();
    expect(statusLine()).toBe('Opening the microphone feed…');
    expect(el<HTMLInputElement>('askInput').disabled).toBe(true);
    expect(el<HTMLButtonElement>('askBtn').disabled).toBe(true);

    submitAsk('typed while locked');
    await flush();
    expect(api.askQuestion).not.toHaveBeenCalled();

    el('recordBtn').click(); // abort the start
    expect(statusLine()).toBe(HOTKEY_READY);
    expect(el<HTMLInputElement>('askInput').disabled).toBe(false);
  });
});

describe('recording lifecycle', () => {
  test('record → stop → answer drives the full UI cycle', async () => {
    const { api, fire } = await boot();
    stubCapture();
    el('recordBtn').click();
    await flush();

    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(el('recordLabel').textContent).toBe('Stop & Answer');
    expect(el('statusDot').className).toBe('dot recording');
    expect(el('recordBtn').classList.contains('recording')).toBe(true);
    expect(el('liveTag').hidden).toBe(false);
    expect(el('transcriptBox').textContent).toBe('Listening…');
    expect(el<HTMLInputElement>('askInput').disabled).toBe(true);

    fire.sttPartial({ sessionId: 1, text: 'What is your greatest', isFinal: false });
    await frame();
    expect(el('transcriptBox').textContent).toBe('What is your greatest');

    el('recordBtn').click(); // stop
    expect(statusLine()).toBe('Finalizing transcript…');
    expect(el('recordLabel').textContent).toBe('Record');
    expect(el('liveTag').hidden).toBe(true);
    expect(el<HTMLInputElement>('askInput').disabled).toBe(true); // still locked
    expect(el('timer').textContent).toBe(''); // meter/timer reset with capture
    await flush();
    expect(api.stopSession).toHaveBeenCalledWith(1);

    fire.sttPartial({ sessionId: 1, text: 'What is your greatest strength?', isFinal: true });
    fire.llmDelta({ sessionId: 1, delta: 'Focus on **impact**' });
    expect(statusLine()).toBe('Generating answer…');
    expect(el('genTag').hidden).toBe(false);
    await frame();
    expect(el('answerBox').querySelector('strong')?.textContent).toBe('impact');

    fire.llmDone({
      sessionId: 1,
      transcript: 'What is your greatest strength?',
      answer: 'Focus on **impact**.',
      metrics: metrics(),
    });
    expect(statusLine()).toBe('Done — press Record for the next question');
    expect(el('latencyTag').hidden).toBe(false);
    expect(el<HTMLInputElement>('askInput').disabled).toBe(false);
    expect(el('copyBtn').hidden).toBe(false);
  });

  test('audio frames buffer while the session opens, then flush in order', async () => {
    const { api, fire } = await boot();
    const cap = stubCapture();
    const gate = deferred<Result<number>>();
    api.startSession.mockImplementationOnce(() => gate.promise);

    el('recordBtn').click();
    await flush(); // capture is up; the session is still connecting
    expect(statusLine()).toBe('Opening the microphone feed…');
    const port = cap.worklets[0]!.port;
    const bufA = new ArrayBuffer(2);
    const bufB = new ArrayBuffer(4);
    port.onmessage!({ data: { pcm: bufA, rms: 0.2 } });
    // Nothing is sent yet — but the meter already moves on local audio.
    expect(el('meterFill').style.width).toBe('60%');
    port.onmessage!({ data: { pcm: bufB, rms: 0.4 } });
    expect(api.sendAudio).not.toHaveBeenCalled();

    gate.resolve({ ok: true, value: 7 });
    await flush();
    // Buffered frames went out first, in capture order, to the adopted id.
    expect(api.sendAudio.mock.calls).toEqual([
      [7, bufA],
      [7, bufB],
    ]);
    const bufC = new ArrayBuffer(8);
    port.onmessage!({ data: { pcm: bufC, rms: 0.1 } });
    expect(api.sendAudio).toHaveBeenLastCalledWith(7, bufC);

    fire.sessionError({ sessionId: 7, error: { code: 'stt_error', message: 'done here' } });
    expect(cap.audioTrack.stop).toHaveBeenCalled();
  });

  test('a capture failure tears down the pre-warmed session and reports', async () => {
    const { api } = await boot();
    api.startSession.mockResolvedValueOnce({ ok: true, value: 3 });
    // Default beforeEach stub: getDisplayMedia rejects (both attempts).
    el('recordBtn').click();
    await flush();

    expect(el('errorBox').hidden).toBe(false);
    expect(el('errorBox').textContent).toContain('Could not open the microphone');
    expect(statusLine()).toBe(HOTKEY_READY);
    expect(api.cancelSession).toHaveBeenCalledWith(3); // the orphaned session died
    // The empty live entry was discarded, not kept as a blank history row.
    expect(el('transcriptBox').textContent).toBe(TRANSCRIPT_PLACEHOLDER);
    expect(el('historyBar').hidden).toBe(true);
  });

  test('a failed session start also stops the capture that came up', async () => {
    const { api } = await boot();
    const cap = stubCapture();
    api.startSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'no_stt_key', message: 'Add your Deepgram key' },
    });
    el('recordBtn').click();
    await flush();

    expect(el('errorBox').textContent).toBe('Add your Deepgram key');
    expect(statusLine()).toBe(HOTKEY_READY);
    expect(cap.audioTrack.stop).toHaveBeenCalled();
    expect(api.cancelSession).not.toHaveBeenCalled(); // no session ever opened
  });

  test('aborting a pending start cleans up when the capture finally arrives', async () => {
    const { api } = await boot();
    const cap = stubCapture({ defer: true });
    el('recordBtn').click();
    await flush(); // session id 1 adopted; getDisplayMedia still pending
    expect(statusLine()).toBe('Opening the microphone feed…');

    el('recordBtn').click(); // abort while starting
    expect(statusLine()).toBe(HOTKEY_READY);
    expect(api.cancelSession).not.toHaveBeenCalled(); // nothing reachable to cancel yet

    // The user is long gone when getDisplayMedia finally resolves: the stale
    // run must stop its own capture and cancel its own session, silently.
    cap.releaseDisplayMedia();
    await flush();
    expect(cap.audioTrack.stop).toHaveBeenCalled();
    expect(api.cancelSession).toHaveBeenCalledWith(1);
    expect(statusLine()).toBe(HOTKEY_READY); // the UI never flickered
    expect(el('errorBox').hidden).toBe(true);
  });

  test('a session error during recording discards the empty question', async () => {
    const { fire } = await boot();
    const cap = stubCapture();
    el('recordBtn').click();
    await flush();
    expect(el('liveTag').hidden).toBe(false);

    fire.sessionError({ sessionId: 1, error: { code: 'stt_error', message: 'socket died' } });
    expect(el('errorBox').textContent).toBe('socket died');
    expect(statusLine()).toBe(HOTKEY_READY);
    expect(el('liveTag').hidden).toBe(true);
    // Nothing was captured, so no blank history entry survives.
    expect(el('transcriptBox').textContent).toBe(TRANSCRIPT_PLACEHOLDER);
    expect(el('historyBar').hidden).toBe(true);
    expect(cap.audioTrack.stop).toHaveBeenCalled(); // capture torn down with it
  });

  test('a failing stopSession does not strand the UI in finalizing', async () => {
    const { api } = await boot();
    stubCapture();
    el('recordBtn').click();
    await flush();
    api.stopSession.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'stop failed' },
    });
    el('recordBtn').click();
    await flush();

    expect(el('errorBox').textContent).toBe('stop failed');
    expect(statusLine()).toBe(HOTKEY_READY);
  });
});

describe('hotkey', () => {
  test('the global hotkey toggles record and stop', async () => {
    const { api, fire } = await boot();
    stubCapture();
    fire.hotkey();
    await flush();
    expect(api.startSession).toHaveBeenCalledTimes(1);
    expect(el('recordLabel').textContent).toBe('Stop & Answer');

    fire.hotkey();
    await flush();
    expect(api.stopSession).toHaveBeenCalledWith(1);
    expect(statusLine()).toBe('Finalizing transcript…');

    fire.sessionError({ sessionId: 1, error: { code: 'aborted', message: 'end of test' } });
  });

  test('the hotkey is ignored while Settings is open', async () => {
    const { api, fire } = await boot();
    el('settingsBtn').click();
    await flush();
    fire.hotkey();
    await flush();
    expect(api.startSession).not.toHaveBeenCalled();

    pressEscape(); // back on the main view the same press works again
    fire.hotkey();
    await flush();
    expect(api.startSession).toHaveBeenCalledTimes(1);
  });
});

describe('history', () => {
  test('completed answers stack and prev/next walk them', async () => {
    const { fire } = await boot();
    await completeAsk(fire, 'Q1', 'A1');
    await completeAsk(fire, 'Q2', 'A2');

    expect(el('historyBar').hidden).toBe(false);
    expect(el('historyLabel').textContent).toBe('2/2');
    expect(el<HTMLButtonElement>('prevBtn').disabled).toBe(false);
    expect(el<HTMLButtonElement>('nextBtn').disabled).toBe(true);

    el('prevBtn').click();
    expect(el('transcriptBox').textContent).toBe('Q1');
    expect(el('answerBox').textContent).toBe('A1');
    expect(el('historyLabel').textContent).toBe('1/2');
    expect(el<HTMLButtonElement>('prevBtn').disabled).toBe(true);
    expect(el<HTMLButtonElement>('nextBtn').disabled).toBe(false);

    el('nextBtn').click();
    expect(el('transcriptBox').textContent).toBe('Q2');
    expect(el('historyLabel').textContent).toBe('2/2');
  });

  test('the seventh answer pushes the first out (MAX_HISTORY)', async () => {
    const { fire } = await boot();
    for (let i = 1; i <= 7; i += 1) await completeAsk(fire, `Q${i}`, `A${i}`);
    expect(el('historyLabel').textContent).toBe('6/6');

    for (let i = 0; i < 5; i += 1) el('prevBtn').click();
    expect(el('historyLabel').textContent).toBe('1/6');
    expect(el('transcriptBox').textContent).toBe('Q2'); // Q1 fell off the front
    expect(el<HTMLButtonElement>('prevBtn').disabled).toBe(true);
  });

  test('regenerate re-asks the question being viewed, not the newest one', async () => {
    const { api, fire } = await boot();
    await completeAsk(fire, 'Q1', 'A1');
    await completeAsk(fire, 'Q2', 'A2');
    el('prevBtn').click(); // viewing Q1

    el('regenBtn').click();
    await flush();
    expect(api.askQuestion).toHaveBeenLastCalledWith('Q1', expect.objectContaining({ snapshot: expect.objectContaining({ profileName: 'Interview' }) }));
    // The re-ask begins a new live entry at the end of the history.
    expect(el('historyLabel').textContent).toBe('3/3');
    expect(el('transcriptBox').textContent).toBe('Q1');
    expect(statusLine()).toBe('Generating answer…');

    fire.llmDone({ sessionId: 1, transcript: 'Q1', answer: 'A1 again', metrics: metrics() });
  });

  test('regenerate hides while a recording is in flight', async () => {
    const { fire } = await boot();
    stubCapture();
    await completeAsk(fire, 'Q1', 'A1');
    expect(el('regenBtn').hidden).toBe(false);

    el('recordBtn').click();
    await flush();
    expect(el('regenBtn').hidden).toBe(true); // recording — no re-ask

    fire.sessionError({ sessionId: 1, error: { code: 'aborted', message: 'end of test' } });
    // The empty live entry was dropped, Q1 is viewed again, and idle re-offers it.
    expect(el('regenBtn').hidden).toBe(false);
  });

  test('clear wipes history, announces it, and moves focus to Record', async () => {
    const { fire } = await boot();
    await completeAsk(fire, 'Q1', 'A1');
    await completeAsk(fire, 'Q2', 'A2');

    el('clearBtn').click();
    expect(el('transcriptBox').textContent).toBe(TRANSCRIPT_PLACEHOLDER);
    expect(el('answerBox').textContent).toBe(ANSWER_PLACEHOLDER);
    expect(el('historyBar').hidden).toBe(true);
    expect(el('latencyTag').hidden).toBe(true);
    expect(el('copyBtn').hidden).toBe(true);
    expect(el('regenBtn').hidden).toBe(true);
    expect(el('srAnnounce').textContent).toBe('History cleared');
    // The Clear button just vanished with its bar; focus must not be stranded.
    expect(document.activeElement?.id).toBe('recordBtn');
  });

  test('clear is refused while an answer is streaming', async () => {
    const { fire } = await boot();
    await completeAsk(fire, 'Q1', 'A1');
    submitAsk('Q2');
    await flush();
    expect(el<HTMLButtonElement>('clearBtn').disabled).toBe(true);

    el('clearBtn').click(); // a click anyway (e.g. via keyboard) is a no-op
    expect(el('historyLabel').textContent).toBe('2/2');

    fire.llmDone({ sessionId: 1, transcript: 'Q2', answer: 'A2', metrics: metrics() });
    expect(el<HTMLButtonElement>('clearBtn').disabled).toBe(false);
  });
});

describe('copy', () => {
  test('copies the markdown source, not the rendered text', async () => {
    const { fire } = await boot();
    await completeAsk(fire, 'Q', 'A **bold** claim');
    expect(el('answerBox').textContent).toBe('A bold claim'); // rendered form

    el('copyBtn').click();
    await flush();
    expect(clipboardWrite).toHaveBeenCalledWith('A **bold** claim'); // source form
    expect(el('copyLabel').textContent).toBe('Copied ✓');
    expect(el('srAnnounce').textContent).toBe('Answer copied');
  });

  test('is hidden until there is an answer to copy', async () => {
    const { fire } = await boot();
    expect(el('copyBtn').hidden).toBe(true);
    submitAsk('Q');
    await flush();
    expect(el('copyBtn').hidden).toBe(true); // question alone is not copyable

    fire.llmDelta({ sessionId: 1, delta: 'first words' });
    await frame();
    expect(el('copyBtn').hidden).toBe(false); // a partial answer already is

    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'first words.', metrics: metrics() });
    expect(el('copyBtn').hidden).toBe(false);
  });

  test('a clipboard failure surfaces in the error box', async () => {
    const { fire } = await boot();
    await completeAsk(fire, 'Q', 'A');
    clipboardWrite.mockRejectedValueOnce(new Error('denied'));

    el('copyBtn').click();
    await flush();
    expect(el('errorBox').hidden).toBe(false);
    expect(el('errorBox').textContent).toBe('Could not copy to the clipboard.');
  });
});

describe('style chips', () => {
  test('clicking a chip persists it and reflects what main returned', async () => {
    const { api } = await boot({ answerStyle: 'balanced' });
    // Main gets the last word: it returns a *different* style than was clicked
    // (e.g. a concurrent settings save won), and the chips must show that.
    api.saveSettings.mockResolvedValueOnce(makeSettings({ answerStyle: 'detailed' }));

    el('styleBrief').click();
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ answerStyle: 'brief', contextProfiles: expect.any(Array) }));
    expect(el('styleDetailed').getAttribute('aria-pressed')).toBe('true');
    expect(el('styleBrief').getAttribute('aria-pressed')).toBe('false');
    expect(el('styleBalanced').getAttribute('aria-pressed')).toBe('false');
  });

  test('a failed style save shows the error', async () => {
    const { api } = await boot();
    api.saveSettings.mockRejectedValueOnce(new Error('store locked'));
    el('styleBrief').click();
    await flush();
    expect(el('errorBox').hidden).toBe(false);
    expect(el('errorBox').textContent).toBe('store locked');
  });
});

describe('settings', () => {
  test('opening populates the form from the live settings view', async () => {
    await boot({
      resume: 'RES text',
      jobDescription: 'JD text',
      llmProvider: 'groq',
      answerStyle: 'detailed',
      hotkey: 'Alt+X',
      alwaysOnTop: true,
      hasDeepgramKey: true,
      hasAnthropicKey: false,
      hasGroqKey: true,
    });
    el('settingsBtn').click();
    await flush();

    expect(el('mainView').hidden).toBe(true);
    expect(el('settingsView').hidden).toBe(false);
    expect(el<HTMLTextAreaElement>('resume').value).toBe('RES text');
    expect(el<HTMLTextAreaElement>('jobDescription').value).toBe('JD text');
    expect(el<HTMLSelectElement>('llmProvider').value).toBe('groq');
    expect(el<HTMLSelectElement>('answerStyle').value).toBe('detailed');
    expect(el<HTMLInputElement>('hotkey').value).toBe('Alt+X');
    expect(el<HTMLInputElement>('hotkey').placeholder).toBe(DEFAULT_HOTKEY);
    expect(el<HTMLInputElement>('alwaysOnTop').checked).toBe(true);
    // Keys are write-only: presence shows as a placeholder, never a value.
    expect(el<HTMLInputElement>('deepgramKey').placeholder).toContain('saved');
    expect(el<HTMLInputElement>('anthropicKey').placeholder).toBe('sk-ant-...');
    expect(el<HTMLInputElement>('groqKey').placeholder).toContain('saved');
    expect(el<HTMLInputElement>('deepgramKey').value).toBe('');
    expect(document.activeElement?.id).toBe('settingsHeading');

    pressEscape();
  });

  test('Escape closes Settings and is inert on the main view', async () => {
    await boot();
    el('settingsBtn').click();
    await flush();
    expect(el('settingsView').hidden).toBe(false);

    pressEscape();
    expect(el('settingsView').hidden).toBe(true);
    expect(el('mainView').hidden).toBe(false);
    expect(document.activeElement?.id).toBe('settingsBtn');

    pressEscape(); // nothing open — must not throw or change anything
    expect(el('mainView').hidden).toBe(false);
  });

  test('the Back button closes too', async () => {
    await boot();
    el('settingsBtn').click();
    await flush();
    el('backBtn').click();
    expect(el('settingsView').hidden).toBe(true);
    expect(el('mainView').hidden).toBe(false);
  });

  test('save sends the form and only the key fields that were typed', async () => {
    const { api } = await boot();
    el('settingsBtn').click();
    await flush();

    el<HTMLTextAreaElement>('resume').value = 'new resume';
    el<HTMLInputElement>('hotkey').value = '  Alt+P  ';
    el<HTMLInputElement>('deepgramKey').value = '  dg_fresh  ';
    // anthropicKey / groqKey left untouched: they must not appear in the patch,
    // because an empty string would *clear* the stored keys.
    api.saveSettings.mockResolvedValueOnce(
      makeSettings({ resume: 'CANONICAL RESUME', answerStyle: 'brief' }),
    );
    el('saveBtn').click();
    await flush();

    const patch = api.saveSettings.mock.calls.at(-1)?.[0] as SettingsPatch;
    expect(patch).toMatchObject({
      resume: 'new resume',
      hotkey: 'Alt+P',
      deepgramKey: 'dg_fresh',
    });
    expect('anthropicKey' in patch).toBe(false);
    expect('groqKey' in patch).toBe(false);

    expect(el('savedNote').hidden).toBe(false);
    // The form re-fills from what main persisted, not from what was typed.
    expect(el<HTMLTextAreaElement>('resume').value).toBe('CANONICAL RESUME');
    expect(el<HTMLInputElement>('deepgramKey').value).toBe(''); // key box always drains
    // The main-view chips track the saved style too.
    expect(el('styleBrief').getAttribute('aria-pressed')).toBe('true');

    pressEscape();
  });

  test('a failed save reports in the settings-local error box', async () => {
    const { api } = await boot();
    el('settingsBtn').click();
    await flush();
    api.saveSettings.mockRejectedValueOnce(new Error('cannot write settings.json'));

    el('saveBtn').click();
    await flush();
    // The main error box lives on the hidden main view; settings has its own.
    expect(el('settingsError').hidden).toBe(false);
    expect(el('settingsError').textContent).toBe('cannot write settings.json');
    expect(el('savedNote').hidden).toBe(true);
    expect(el('settingsView').hidden).toBe(false); // still open for a retry

    pressEscape();
  });

  test('a saved view that disables the hotkey re-arms the main-view hints', async () => {
    const { api } = await boot(); // hotkey active at boot
    expect(el('hotkeyHint').hidden).toBe(false);
    el('settingsBtn').click();
    await flush();

    api.saveSettings.mockResolvedValueOnce(makeSettings({ hotkey: '' }));
    el('saveBtn').click();
    await flush();
    expect(el('hotkeyHint').hidden).toBe(true);
    expect(statusLine()).toBe(BASE_READY); // ready text no longer names the hotkey

    pressEscape();
  });
});

function inputValue(id: string, value: string): void {
  el<HTMLInputElement>(id).value = value;
  el(id).dispatchEvent(new Event('input', { bubbles: true }));
}

function lastSnapshot(api: ApiMock) {
  return api.askQuestion.mock.calls.at(-1)?.[1]?.snapshot;
}

describe('explicit context and refinements', () => {
  test('a draft applies immediately to the next ask and remains fixed while streaming', async () => {
    const { api, fire } = await boot();
    inputValue('contextBackground', 'Project Atlas');
    inputValue('contextInstructions', 'Discuss the migration');
    inputValue('questionNote', 'Mention testing');
    submitAsk('How did it go?');
    await flush();
    const snapshot = lastSnapshot(api)!;
    expect(snapshot.background).toBe('Project Atlas');
    expect(snapshot.questionNote).toBe('Mention testing');
    inputValue('contextBackground', 'Project Borealis');
    expect(snapshot.background).toBe('Project Atlas');
    expect(el('contextTiming').textContent).toContain('next question');
    fire.llmDone({ sessionId: 1, transcript: 'How did it go?', answer: 'A', metrics: metrics() });
    expect(el('entryContextText').textContent).toContain('Project Atlas');
    expect(el('entryContextText').textContent).not.toContain('Project Borealis');
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('');
  });

  test('Record captures the context before capture or transcription resolves', async () => {
    const { api, fire } = await boot();
    const capture = stubCapture({ defer: true });
    inputValue('contextBackground', 'At Record');
    el('recordBtn').click();
    inputValue('contextBackground', 'After Record');
    expect(api.startSession.mock.calls[0]?.[0]?.snapshot?.background).toBe('At Record');
    capture.releaseDisplayMedia();
    await flush();
    el('recordBtn').click();
    await flush();
    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A', metrics: metrics() });
    expect(el('entryContextText').textContent).toContain('At Record');
  });

  test('note survives failures and a newer note survives an older successful answer', async () => {
    const { api, fire } = await boot();
    inputValue('questionNote', 'Keep on error');
    api.askQuestion.mockResolvedValueOnce({ ok: false, error: { code: 'no_llm_key', message: 'missing key' } });
    submitAsk('Q');
    await flush();
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('Keep on error');
    submitAsk('Q');
    await flush();
    fire.sessionError({ sessionId: 1, error: { code: 'llm_timeout', message: 'timeout' } });
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('Keep on error');
    submitAsk('Q');
    await flush();
    inputValue('questionNote', 'For next question');
    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A', metrics: metrics() });
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('For next question');
  });

  test('retyping the same note is still a new note and is retained', async () => {
    const { fire } = await boot();
    inputValue('questionNote', 'Same text');
    submitAsk('Q');
    await flush();
    inputValue('questionNote', '');
    inputValue('questionNote', 'Same text');
    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A', metrics: metrics() });
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('Same text');
  });

  test('original regeneration preserves its snapshot; current regeneration uses the draft', async () => {
    const { api, fire } = await boot();
    inputValue('contextBackground', 'Original');
    await completeAsk(fire, 'Q', 'A');
    inputValue('contextBackground', 'Updated');
    inputValue('questionNote', 'Next only');
    el('regenBtn').click();
    await flush();
    expect(lastSnapshot(api)?.background).toBe('Original');
    expect(lastSnapshot(api)?.questionNote).toBe('');
    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A2', metrics: metrics() });
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('Next only');
    el('regenCurrentBtn').click();
    await flush();
    expect(lastSnapshot(api)?.background).toBe('Updated');
    expect(lastSnapshot(api)?.questionNote).toBe('Next only');
  });

  test('followup sends only the explicitly selected bounded AI suggestion and does not become global memory', async () => {
    const { api, fire } = await boot();
    await completeAsk(fire, 'Original question', 'x'.repeat(5000));
    el('followupBtn').click();
    expect(el('followupLabel').textContent).toContain('not something you said');
    submitAsk('Expand that');
    await flush();
    expect(lastSnapshot(api)?.relatedAnswer).toEqual({ question: 'Original question', answer: 'x'.repeat(CONTEXT_LIMITS.relatedAnswer) });
    fire.llmDone({ sessionId: 1, transcript: 'Expand that', answer: 'Expanded', metrics: metrics() });
    submitAsk('Independent question');
    await flush();
    expect(lastSnapshot(api)?.relatedAnswer).toBeUndefined();
  });

  test('refinement and edit operate on the selected entry with its original context', async () => {
    const { api, fire } = await boot();
    inputValue('contextBackground', 'Original project');
    await completeAsk(fire, 'Q1', 'A1');
    inputValue('contextBackground', 'New project');
    await completeAsk(fire, 'Q2', 'A2');
    el('prevBtn').click();
    el('shorterBtn').click();
    await flush();
    expect(lastSnapshot(api)?.background).toBe('Original project');
    expect(lastSnapshot(api)?.relatedAnswer).toEqual({ question: 'Q1', answer: 'A1' });
    expect(lastSnapshot(api)?.refinement).toContain('shorter');
    expect(lastSnapshot(api)?.output).toMatchObject({ answerStyle: 'brief', format: 'spoken', tone: 'confident', audience: 'general' });
    fire.llmDone({ sessionId: 1, transcript: 'Q1', answer: 'Short', metrics: metrics() });
    el('editQuestionBtn').click();
    expect(el<HTMLInputElement>('askInput').value).toBe('Q1');
    submitAsk('Edited Q1');
    await flush();
    expect(lastSnapshot(api)?.background).toBe('Original project');
    expect(api.askQuestion.mock.calls.at(-1)?.[0]).toBe('Edited Q1');
  });

  test('an early completion is replayed, stale events in the buffer are ignored', async () => {
    const { api, fire } = await boot();
    const gate = deferred<Result<number>>();
    api.askQuestion.mockImplementationOnce(() => gate.promise);
    inputValue('questionNote', 'Used');
    submitAsk('Q');
    fire.llmDone({ sessionId: 99, transcript: 'Wrong', answer: 'Wrong', metrics: metrics() });
    fire.llmDone({ sessionId: 2, transcript: 'Q', answer: 'Correct', metrics: metrics() });
    gate.resolve({ ok: true, value: 2 });
    await flush();
    expect(el('answerBox').textContent).toBe('Correct');
    expect(el<HTMLTextAreaElement>('questionNote').value).toBe('');
    expect(el('genTag').hidden).toBe(true);
  });

  test('switching scenario picks safe inclusion defaults but preserves custom instructions', async () => {
    const { api } = await boot();
    inputValue('contextInstructions', 'My custom instructions');
    inputValue('scenario', 'client');
    submitAsk('Q');
    await flush();
    expect(lastSnapshot(api)).toMatchObject({ situation: 'client', resume: '', jobDescription: '', instructions: 'My custom instructions' });
  });
});

describe('profiles and key clearing', () => {
  test('failed profile save retains the edited draft for retry and for the next question', async () => {
    const { api } = await boot();
    inputValue('contextBackground', 'Unsaved draft');
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    el('profileSave').click();
    await flush();
    expect(el<HTMLTextAreaElement>('contextBackground').value).toBe('Unsaved draft');
    expect(el('profileStatus').textContent).toContain('draft is still available');
    submitAsk('Q');
    await flush();
    expect(lastSnapshot(api)?.background).toBe('Unsaved draft');
  });

  test('profiles can be created, duplicated, renamed, switched and deleted', async () => {
    const initial = makeSettings({ contextProfiles: [createDefaultProfile()], activeProfileId: 'interview' });
    const { api } = await boot(initial, (api) => {
      api.saveSettings.mockImplementation(async (patch) => Object.assign(initial, patch));
    });
    el('profileNew').click();
    await flush();
    expect(el<HTMLSelectElement>('profileSelect').options.length).toBe(2);
    inputValue('profileName', 'Customer discovery');
    el('profileRename').click();
    await flush();
    expect(el('contextSummary').textContent).toContain('Customer discovery');
    el('profileDuplicate').click();
    await flush();
    expect(el<HTMLSelectElement>('profileSelect').options.length).toBe(3);
    expect(el('contextSummary').textContent).toContain('Customer discovery copy');
    el<HTMLSelectElement>('profileSelect').value = 'interview';
    el('profileSelect').dispatchEvent(new Event('change'));
    await flush();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ activeProfileId: 'interview' });
    el('profileDelete').click();
    await flush();
    expect(el<HTMLSelectElement>('profileSelect').options.length).toBe(2);
    expect(el('contextSummary').textContent).toContain('Customer discovery');
  });

  test('length chips change the active profile length without saving its unrelated draft edits', async () => {
    const profile = createProfile('technical', 'technical', 'Engineering');
    profile.output.answerStyle = 'detailed';
    const initial = makeSettings({ contextProfiles: [profile], activeProfileId: profile.id });
    const { api } = await boot(initial, (api) => {
      api.saveSettings.mockImplementation(async (patch) => Object.assign(initial, patch));
    });
    inputValue('contextBackground', 'Unsaved background');
    el('styleBrief').click();
    await flush();
    expect(api.saveSettings.mock.calls[0]?.[0].contextProfiles?.[0]?.background).toBe('');
    submitAsk('Q');
    await flush();
    expect(lastSnapshot(api)?.output.answerStyle).toBe('brief');
    expect(lastSnapshot(api)?.background).toBe('Unsaved background');
  });

  test('only explicitly selected keys are cleared; untouched keys stay absent from patch', async () => {
    const { api } = await boot();
    el('settingsBtn').click();
    await flush();
    el<HTMLInputElement>('clearAnthropicKey').checked = true;
    el('saveBtn').click();
    await flush();
    const patch = api.saveSettings.mock.calls[0]![0];
    expect(patch.anthropicKey).toBe('');
    expect(patch).not.toHaveProperty('deepgramKey');
    expect(patch).not.toHaveProperty('groqKey');
    expect(el<HTMLInputElement>('clearAnthropicKey').checked).toBe(false);
  });
});

describe('context lifecycle races', () => {
  test('Ask, Record and hotkey wait for saved settings before taking a snapshot', async () => {
    const gate = deferred<SettingsView>();
    const { api, fire } = await boot({}, (api) => api.getSettings.mockImplementationOnce(() => gate.promise));
    submitAsk('Too early');
    el('recordBtn').click();
    fire.hotkey();
    expect(api.askQuestion).not.toHaveBeenCalled();
    expect(api.startSession).not.toHaveBeenCalled();
    expect(el<HTMLButtonElement>('askBtn').disabled).toBe(true);
    gate.resolve(makeSettings({ resume: 'Saved facts' }));
    await flush();
    submitAsk('Ready');
    await flush();
    expect(lastSnapshot(api)?.resume).toBe('Saved facts');
  });

  test.each(['New', 'Duplicate', 'Delete'])('failed %s keeps visible profile and request context aligned', async (action) => {
    const first = createDefaultProfile();
    const second = createProfile('client', 'client', 'Client');
    const { api } = await boot({ contextProfiles: [first, second], activeProfileId: first.id });
    inputValue('contextBackground', 'Retained draft');
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    el(`profile${action}`).click();
    await flush();
    expect(el<HTMLInputElement>('profileName').value).toBe('Interview');
    expect(el<HTMLSelectElement>('profileSelect').options.length).toBe(2);
    submitAsk('Q');
    await flush();
    expect(lastSnapshot(api)).toMatchObject({ profileName: 'Interview', background: 'Retained draft', resume: 'a resume' });
  });

  test('a delayed length save targets its original profile after the selection changes', async () => {
    const first = createDefaultProfile();
    const second = createProfile('client', 'client', 'Client');
    const settings = makeSettings({ contextProfiles: [first, second], activeProfileId: first.id });
    const gate = deferred<SettingsView>();
    const { api } = await boot(settings);
    api.saveSettings.mockImplementationOnce(() => gate.promise);
    el('styleBrief').click();
    el<HTMLSelectElement>('profileSelect').value = 'client';
    el('profileSelect').dispatchEvent(new Event('change'));
    gate.resolve(makeSettings({ answerStyle: 'brief', contextProfiles: [{ ...first, output: { answerStyle: 'brief' } }, second], activeProfileId: first.id }));
    await flush();
    el('profileSave').click();
    await flush();
    const savedSecond = api.saveSettings.mock.calls.at(-1)?.[0].contextProfiles?.find((p) => p.id === 'client');
    expect(savedSecond?.output).toEqual({});
    expect(el<HTMLInputElement>('profileName').value).toBe('Client');
  });

  test('active profile length wins in the chips and survives saving unrelated settings', async () => {
    const profile = createDefaultProfile('detailed');
    const settings = makeSettings({ answerStyle: 'balanced', contextProfiles: [profile], activeProfileId: profile.id });
    const { api } = await boot(settings);
    expect(el('styleDetailed').getAttribute('aria-pressed')).toBe('true');
    el('settingsBtn').click();
    await flush();
    el('saveBtn').click();
    await flush();
    el('backBtn').click();
    submitAsk('Q');
    await flush();
    expect(lastSnapshot(api)?.output.answerStyle).toBe('detailed');
  });

  test('a failed follow-up can be retried without reselecting its source', async () => {
    const { api, fire } = await boot();
    await completeAsk(fire, 'Original', 'Suggestion');
    el('followupBtn').click();
    api.askQuestion.mockResolvedValueOnce({ ok: false, error: { code: 'no_llm_key', message: 'missing key' } });
    submitAsk('Follow up');
    await flush();
    expect(el('followupBanner').hidden).toBe(false);
    submitAsk('Follow up');
    await flush();
    expect(lastSnapshot(api)?.relatedAnswer).toEqual({ question: 'Original', answer: 'Suggestion' });
    fire.llmDone({ sessionId: 1, transcript: 'Follow up', answer: 'A', metrics: metrics() });
    expect(el('followupBanner').hidden).toBe(true);
  });
});

 test('refinement controls stay collapsed after answering until the user opens them', async () => {
  const { fire } = await boot();
  await completeAsk(fire, 'Q', 'A readable suggested answer.');
  const actions = el<HTMLDetailsElement>('answerActions');
  expect(actions.tagName).toBe('DETAILS');
  expect(actions.hidden).toBe(false);
  expect(actions.open).toBe(false);
  expect(actions.querySelector('summary')?.textContent).toBe('Refine or follow up');
  actions.open = true;
  expect(actions.querySelector('#shorterBtn')).not.toBeNull();
});

describe('merged practice features', () => {
  test('recording defaults to microphone and saved system source uses loopback instead', async () => {
    const { fire } = await boot();
    stubCapture();
    el('recordBtn').click();
    await flush();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled();
    el('recordBtn').click();
    await flush();
    fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A', metrics: metrics() });
    const system = await boot({ audioSource: 'system' });
    stubCapture();
    el('recordBtn').click();
    await flush();
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    el('recordBtn').click();
    await flush();
    system.fire.llmDone({ sessionId: 1, transcript: 'Q', answer: 'A', metrics: metrics() });
  });

  test('personalization and model settings load, save, snapshot and retain drafts on failure', async () => {
    const initial = makeSettings({ personalProfile: 'Python engineer', customInstructions: 'Use concrete examples', anthropicModel: 'claude-haiku-4-5', groqModel: 'openai/gpt-oss-120b', audioSource: 'microphone' });
    const { api } = await boot(initial, (api) => api.saveSettings.mockImplementation(async (patch) => Object.assign(initial, patch)));
    el('settingsBtn').click();
    await flush();
    expect(el<HTMLTextAreaElement>('personalProfile').value).toBe('Python engineer');
    expect(el<HTMLSelectElement>('anthropicModel').disabled).toBe(false);
    expect(el<HTMLSelectElement>('groqModel').disabled).toBe(true);
    el<HTMLSelectElement>('llmProvider').value = 'groq';
    el('llmProvider').dispatchEvent(new Event('change'));
    expect(el<HTMLSelectElement>('groqModel').disabled).toBe(false);
    expect(el<HTMLSelectElement>('anthropicModel').disabled).toBe(true);
    inputValue('groqModel', 'openai/gpt-oss-20b');
    inputValue('personalProfile', 'Engineering manager');
    inputValue('customInstructions', 'Explain the business impact');
    inputValue('audioSource', 'system');
    el('saveBtn').click();
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ personalProfile: 'Engineering manager', customInstructions: 'Explain the business impact', groqModel: 'openai/gpt-oss-20b', audioSource: 'system' }));
    el('backBtn').click();
    submitAsk('Q');
    await flush();
    expect(lastSnapshot(api)).toMatchObject({ personalProfile: 'Engineering manager', customInstructions: 'Explain the business impact' });
    el('settingsBtn').click();
    await flush();
    inputValue('customInstructions', 'Keep this failed draft');
    api.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    el('saveBtn').click();
    await flush();
    expect(el<HTMLTextAreaElement>('customInstructions').value).toBe('Keep this failed draft');
    expect(el('settingsError').textContent).toBe('disk full');
  });

  test('Go deeper and examples preserve selected context with temporary detailed length', async () => {
    const { api, fire } = await boot({ answerStyle: 'brief' });
    inputValue('contextBackground', 'Saved topic');
    await completeAsk(fire, 'What is caching?', 'Reuse results.');
    inputValue('contextBackground', 'Different next topic');
    el('deeperBtn').click();
    await flush();
    expect(api.askQuestion.mock.calls.at(-1)?.[0]).toContain('Go deeper');
    expect(lastSnapshot(api)).toMatchObject({ background: 'Saved topic', output: { answerStyle: 'detailed' }, conversation: [{ question: 'What is caching?', answer: 'Reuse results.' }] });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(el('styleBrief').getAttribute('aria-pressed')).toBe('true');
    expect(el<HTMLButtonElement>('exampleBtn').disabled).toBe(true);
    fire.llmDone({ sessionId: 1, transcript: 'Go deeper on caching', answer: 'Consider invalidation.', metrics: metrics() });
    el('exampleBtn').click();
    await flush();
    expect(api.askQuestion.mock.calls.at(-1)?.[0]).toContain('worked example');
    expect(lastSnapshot(api)?.conversation?.length).toBe(2);
  });

  test('explicit followup chains retain anchor and recent turns and branch from the selected entry', async () => {
    const { api, fire } = await boot();
    await completeAsk(fire, 'Question 0', 'Answer 0');
    for (let i = 1; i <= 8; i++) {
      el('followupBtn').click();
      await completeAsk(fire, `Question ${i}`, `Answer ${i}`);
    }
    expect(lastSnapshot(api)?.conversation).toEqual([
      { question: 'Question 0', answer: 'Answer 0' },
      ...Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i + 3}`, answer: `Answer ${i + 3}` })),
    ]);
    el('prevBtn').click();
    el('prevBtn').click();
    el('followupBtn').click();
    submitAsk('Branch off question 6');
    await flush();
    expect(lastSnapshot(api)?.conversation?.at(-1)).toEqual({ question: 'Question 6', answer: 'Answer 6' });
    expect(lastSnapshot(api)?.conversation?.some((turn) => turn.question === 'Question 7')).toBe(false);
    fire.llmDone({ sessionId: 1, transcript: 'Branch off question 6', answer: 'Branch answer', metrics: metrics() });
    submitAsk('Independent');
    await flush();
    expect(lastSnapshot(api)?.conversation).toBeUndefined();
  });

  test('failed partial answers cannot be selected as completed followup context', async () => {
    const { fire } = await boot();
    submitAsk('Q');
    await flush();
    fire.llmDelta({ sessionId: 1, delta: 'Partial' });
    fire.sessionError({ sessionId: 1, error: { code: 'llm_timeout', message: 'timeout' } });
    expect(el<HTMLButtonElement>('deeperBtn').disabled).toBe(true);
    expect(el<HTMLButtonElement>('exampleBtn').disabled).toBe(true);
    expect(el<HTMLButtonElement>('followupBtn').disabled).toBe(true);
  });

  test('usage chip displays estimated cost or tokens honestly and follows history selection', async () => {
    const { fire } = await boot();
    submitAsk('Q1');
    await flush();
    fire.llmDone({ sessionId: 1, transcript: 'Q1', answer: 'A1', metrics: metrics({ usage: { model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.0023 } }) });
    expect(el('costTag').textContent).toBe('$0.0023');
    expect(el('costTag').title).toContain('claude-haiku-4-5');
    submitAsk('Q2');
    await flush();
    fire.llmDone({ sessionId: 1, transcript: 'Q2', answer: 'A2', metrics: metrics({ usage: { model: 'openai/gpt-oss-120b', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } }) });
    expect(el('costTag').textContent).toBe('100→50 tok');
    expect(el('costTag').title).toContain('pricing not pinned');
    el('prevBtn').click();
    expect(el('costTag').textContent).toBe('$0.0023');
  });
});

test.each(['deeperBtn', 'exampleBtn'])('%s does not replay the source one-question note or consume the next pending note', async (action) => {
  const { api, fire } = await boot();
  inputValue('questionNote', 'Only for the original answer');
  await completeAsk(fire, 'Original question', 'Original answer');
  inputValue('questionNote', 'For my next typed question');
  el(action).click();
  await flush();
  expect(lastSnapshot(api)?.questionNote).toBe('');
  expect(lastSnapshot(api)?.conversation).toEqual([{ question: 'Original question', answer: 'Original answer' }]);
  fire.llmDone({ sessionId: 1, transcript: 'Detailed followup', answer: 'Detailed answer', metrics: metrics() });
  expect(el<HTMLTextAreaElement>('questionNote').value).toBe('For my next typed question');
  submitAsk('My next typed question');
  await flush();
  expect(lastSnapshot(api)?.questionNote).toBe('For my next typed question');
});
