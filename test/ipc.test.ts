import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AppError, Result, SettingsView } from '../src/shared/types';
import type { SttStream } from '../src/main/session';

// The IPC layer is the boundary between the untrusted renderer and the session
// pipeline: zod validation on every argument, Result envelopes on every invoke,
// and session-id-tagged events on the way back. These tests register the real
// handlers (real SessionManager included) against a mocked ipcMain and drive
// them the way the preload would — no Electron, no network.

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  secrets: {} as Record<string, string>,
  profile: {
    resume: 'my resume',
    jobDescription: 'the jd',
    personalProfile: '', customInstructions: '',
    anthropicModel: 'claude-haiku-4-5', groqModel: 'openai/gpt-oss-120b',
    llmProvider: 'anthropic' as string,
    answerStyle: 'balanced' as string,
  },
  view: { resume: 'my resume' } as Record<string, unknown>,
  patches: [] as unknown[],
  // Impl slots filled in beforeEach (the vi.mock factories run before any
  // test-scope code, so they can only close over this object).
  deepgramConnect: null as null | ((key: string) => Promise<SttStream>),
  createAnthropic: null as null | ((...args: unknown[]) => unknown),
  createGroq: null as null | ((...args: unknown[]) => unknown),
  warmCalls: [] as string[],
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      mocked.handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) =>
      mocked.listeners.set(channel, fn),
  },
}));

vi.mock('../src/main/store', () => ({
  getSecret: (key: string) => mocked.secrets[key] ?? '',
  getProfile: () => ({ ...mocked.profile }),
  getSettingsView: () => ({ ...mocked.profile, ...mocked.view }) as unknown as SettingsView,
  applySettingsPatch: (patch: unknown) => {
    mocked.patches.push(patch);
    return { ...mocked.view } as unknown as SettingsView;
  },
}));

vi.mock('../src/main/stt/deepgram', () => ({
  DeepgramStream: { connect: (key: string) => mocked.deepgramConnect!(key) },
}));

vi.mock('../src/main/llm/anthropic', () => ({
  createAnthropicProvider: (...args: unknown[]) => mocked.createAnthropic!(...args),
}));

vi.mock('../src/main/llm/groq', () => ({
  createGroqProvider: (...args: unknown[]) => mocked.createGroq!(...args),
}));

vi.mock('../src/main/llm/warm', () => ({
  warmLlmConnection: (provider: string) => mocked.warmCalls.push(provider),
}));

/** In-memory stand-in for a connected DeepgramStream. */
class FakeStt implements SttStream {
  partialCb: ((text: string, isFinal: boolean) => void) | null = null;
  errorCb: ((error: AppError) => void) | null = null;
  audio: ArrayBuffer[] = [];
  aborted = false;
  transcript = 'What is your greatest strength?';
  onPartial(cb: (text: string, isFinal: boolean) => void): void {
    this.partialCb = cb;
  }
  onError(cb: (error: AppError) => void): void {
    this.errorCb = cb;
  }
  sendAudio(pcm: ArrayBuffer): void {
    this.audio.push(pcm);
  }
  finalize(): Promise<string> {
    return Promise.resolve(this.transcript);
  }
  abort(): void {
    this.aborted = true;
  }
}

/** LLM provider double: streams the given deltas synchronously, then resolves. */
function fakeLlm(deltas: string[] = ['Hello ', 'world.']) {
  return {
    prompts: [] as string[],
    async generate(transcript: string, onDelta: (d: string) => void): Promise<string> {
      this.prompts.push(transcript);
      for (const d of deltas) onDelta(d);
      return deltas.join('');
    },
  };
}

// Test-scope wiring rebuilt per test.
let sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
let winDestroyed = false;
let alwaysOnTopCalls: boolean[] = [];
let connectedKeys: string[] = [];
let stt: FakeStt;
let llm: ReturnType<typeof fakeLlm>;
let anthropicArgs: unknown[][] = [];

const fakeWin = () =>
  ({
    webContents: {
      isDestroyed: () => winDestroyed,
      send: (channel: string, payload: Record<string, unknown>) => {
        if (winDestroyed) throw new Error('send after destroy'); // the guard must prevent this
        sent.push({ channel, payload });
      },
    },
    setAlwaysOnTop: (v: boolean) => alwaysOnTopCalls.push(v),
  }) as never;

async function setup(getWin?: () => never | null): Promise<{ applyHotkey: ReturnType<typeof vi.fn> }> {
  vi.resetModules();
  mocked.handlers.clear();
  mocked.listeners.clear();
  const { registerIpc } = await import('../src/main/ipc');
  const applyHotkey = vi.fn();
  registerIpc(getWin ?? (() => fakeWin()), applyHotkey);
  return { applyHotkey };
}

// Async so a handler that throws synchronously (zod .parse) surfaces as a
// rejection — which is exactly how ipcMain.handle reports it to the renderer.
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const handler = mocked.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler({}, ...args)) as T;
};

const emit = (channel: string, ...args: unknown[]): void => {
  mocked.listeners.get(channel)!({}, ...args);
};

const sentOn = (channel: string) => sent.filter((s) => s.channel === channel).map((s) => s.payload);

/** Start a recorded session through the handler and hand back its id. */
async function startedSession(): Promise<number> {
  const r = await invoke<Result<number>>('session:start');
  if (!r.ok) throw new Error(`start failed: ${r.error.message}`);
  return r.value;
}

beforeEach(() => {
  sent = [];
  winDestroyed = false;
  alwaysOnTopCalls = [];
  connectedKeys = [];
  anthropicArgs = [];
  mocked.secrets = { deepgramKey: 'dg-key', anthropicKey: 'ant-key' };
  mocked.profile = {
    resume: 'my resume',
    jobDescription: 'the jd',
    personalProfile: '', customInstructions: '',
    anthropicModel: 'claude-haiku-4-5', groqModel: 'openai/gpt-oss-120b',
    llmProvider: 'anthropic',
    answerStyle: 'balanced',
  };
  mocked.patches = [];
  mocked.warmCalls = [];
  llm = fakeLlm();
  mocked.deepgramConnect = (key) => {
    connectedKeys.push(key);
    stt = new FakeStt();
    return Promise.resolve(stt);
  };
  mocked.createAnthropic = (...args) => {
    anthropicArgs.push(args);
    return llm;
  };
  mocked.createGroq = () => llm;
});

describe('ipc registration', () => {
  test('registers exactly the channels the preload calls', async () => {
    await setup();
    // The preload's api object is written against these names; a drift on
    // either side strands the renderer with a promise that never resolves.
    expect([...mocked.handlers.keys()].sort()).toEqual([
      'session:ask',
      'session:cancel',
      'session:start',
      'session:stop',
      'settings:get',
      'settings:set',
    ]);
    expect([...mocked.listeners.keys()]).toEqual(['audio:chunk']);
  });
});

describe('ipc settings', () => {
  test('settings:get returns the store view', async () => {
    await setup();
    expect(await invoke('settings:get')).toMatchObject(mocked.view);
  });

  test('settings:set applies a valid patch and returns the fresh view', async () => {
    await setup();
    const view = await invoke('settings:set', { resume: 'updated' });
    expect(mocked.patches).toEqual([{ resume: 'updated' }]);
    expect(view).toMatchObject(mocked.view);
  });

  test('settings:set rejects a wrong-typed field before the store is touched', async () => {
    await setup();
    await expect(invoke('settings:set', { alwaysOnTop: 'yes' })).rejects.toThrow();
    await expect(invoke('settings:set', { llmProvider: 'openai' })).rejects.toThrow();
    expect(mocked.patches).toEqual([]); // validation failed → nothing persisted
  });

  test('settings:set rejects an oversized resume', async () => {
    // The 200k cap exists so a runaway paste cannot bloat every future prompt.
    await setup();
    await expect(invoke('settings:set', { resume: 'x'.repeat(200_001) })).rejects.toThrow();
    expect(mocked.patches).toEqual([]);
  });

  test('settings:set pushes alwaysOnTop to the live window', async () => {
    await setup();
    await invoke('settings:set', { alwaysOnTop: false });
    expect(alwaysOnTopCalls).toEqual([false]);
    // A patch without the field must leave the window alone.
    await invoke('settings:set', { resume: 'r' });
    expect(alwaysOnTopCalls).toEqual([false]);
  });

  test('settings:set re-registers the hotkey only when the patch carries one', async () => {
    const { applyHotkey } = await setup();
    await invoke('settings:set', { resume: 'r' });
    expect(applyHotkey).not.toHaveBeenCalled();
    await invoke('settings:set', { hotkey: 'Alt+Q' });
    expect(applyHotkey).toHaveBeenCalledTimes(1);
    // Empty string = "disable the shortcut" — that is still a change to apply.
    await invoke('settings:set', { hotkey: '' });
    expect(applyHotkey).toHaveBeenCalledTimes(2);
  });

  test('settings:set survives a null window (closed while Settings was open)', async () => {
    await setup(() => null);
    await expect(invoke('settings:set', { alwaysOnTop: true })).resolves.toBeTruthy();
    expect(alwaysOnTopCalls).toEqual([]);
  });
});

describe('ipc session:start', () => {
  test('fails with no_stt_key when the Deepgram key is missing, without dialing out', async () => {
    mocked.secrets = {};
    await setup();
    const r = await invoke<Result<number>>('session:start');
    expect(r).toMatchObject({ ok: false, error: { code: 'no_stt_key' } });
    expect(connectedKeys).toEqual([]);
  });

  test('connects Deepgram with the stored key and returns the session id', async () => {
    await setup();
    const r = await invoke<Result<number>>('session:start');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeGreaterThan(0);
    expect(connectedKeys).toEqual(['dg-key']);
  });

  test('pre-warms the active provider on start, ask and stop', async () => {
    await setup();
    const id = await startedSession();
    await invoke('session:stop', id);
    await invoke('session:ask', 'Tell me about yourself');
    // One warm per user gesture — the throttle lives in warm.ts, not here.
    expect(mocked.warmCalls).toEqual(['anthropic', 'anthropic', 'anthropic']);
    // ask() defers its pipeline a tick; wait it out so its events cannot leak
    // into whichever test runs next (stop's done + ask's done = 2).
    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(2));
  });

  test('forwards live partials tagged with the session id', async () => {
    await setup();
    const id = await startedSession();
    stt.partialCb!('hello wor', false);
    stt.partialCb!('hello world', true);
    expect(sentOn('stt:partial')).toEqual([
      { sessionId: id, text: 'hello wor', isFinal: false },
      { sessionId: id, text: 'hello world', isFinal: true },
    ]);
  });

  test('an STT death mid-recording reaches the renderer as session:error', async () => {
    await setup();
    const id = await startedSession();
    stt.errorCb!({ code: 'stt_error', message: 'socket died' });
    expect(sentOn('session:error')).toEqual([
      { sessionId: id, error: { code: 'stt_error', message: 'socket died' } },
    ]);
    // The session is gone; a Stop pressed afterwards must be told so.
    const r = await invoke<Result<null>>('session:stop', id);
    expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('ipc audio:chunk', () => {
  test('routes a valid frame to the live stream', async () => {
    await setup();
    const id = await startedSession();
    const pcm = new ArrayBuffer(64);
    emit('audio:chunk', id, pcm);
    expect(stt.audio).toEqual([pcm]);
  });

  test('drops malformed session ids and payloads without throwing', async () => {
    await setup();
    const id = await startedSession();
    const pcm = new ArrayBuffer(64);
    // Fire-and-forget channel: hostile input must be inert, not an exception.
    expect(() => emit('audio:chunk', 'not-an-id', pcm)).not.toThrow();
    expect(() => emit('audio:chunk', -1, pcm)).not.toThrow();
    expect(() => emit('audio:chunk', 1.5, pcm)).not.toThrow();
    expect(() => emit('audio:chunk', id, 'not-a-buffer')).not.toThrow();
    expect(() => emit('audio:chunk', id, null)).not.toThrow();
    expect(stt.audio).toEqual([]);
  });

  test('drops audio addressed to a session that is not live', async () => {
    await setup();
    const id = await startedSession();
    emit('audio:chunk', id + 999, new ArrayBuffer(8));
    expect(stt.audio).toEqual([]);
  });
});

// audio:chunk validates with a hand-rolled integer guard instead of zod (it is
// the one per-frame handler, ~8 messages/second for the whole recording).
// These pin that the fast path refuses exactly what the zod schema refused.
describe('ipc audio:chunk fast-path guard', () => {
  test('refuses every malformed id shape without touching the live stream', async () => {
    await setup();
    const id = await startedSession();
    const pcm = new ArrayBuffer(16);
    // Number.isInteger must be doing the work here: NaN/Infinity are typeof
    // number, numeric strings coerce under >, and 0 passes an integer check.
    const bad = [0, -7, 1.5, Number.NaN, Infinity, -Infinity, '1', `${id}`, true, null, undefined, [id], { id }];
    for (const raw of bad) expect(() => emit('audio:chunk', raw, pcm)).not.toThrow();
    expect(stt.audio).toEqual([]);
  });

  test('a boxed Number id is refused — loose coercion must not smuggle audio through', async () => {
    await setup();
    const id = await startedSession();
    // `Object(id) == id` is true; only a typeof/isInteger check catches it.
    // Structured clone can produce such wrappers from a compromised renderer.
    emit('audio:chunk', Object(id), new ArrayBuffer(16));
    expect(stt.audio).toEqual([]);
  });

  test('typed-array views and a missing payload are refused — the contract is a raw ArrayBuffer', async () => {
    await setup();
    const id = await startedSession();
    // A Uint8Array wraps an ArrayBuffer but is not one; forwarding a view
    // would hand Deepgram the view object, not the PCM bytes it frames.
    emit('audio:chunk', id, new Uint8Array(8));
    emit('audio:chunk', id, new DataView(new ArrayBuffer(8)));
    emit('audio:chunk', id);
    expect(stt.audio).toEqual([]);
  });

  test('a well-formed frame still flows after a burst of garbage', async () => {
    await setup();
    const id = await startedSession();
    for (const raw of [0, Number.NaN, 'x', null]) emit('audio:chunk', raw, new ArrayBuffer(4));
    const good = new ArrayBuffer(64);
    emit('audio:chunk', id, good);
    // Rejection must be stateless: bad frames cannot wedge the channel shut.
    expect(stt.audio).toEqual([good]);
  });

  test('audio for a session that already stopped is dropped', async () => {
    await setup();
    const id = await startedSession();
    await invoke('session:stop', id);
    // The id is perfectly valid — it is the session state, not the shape, that
    // must reject this straggler frame from the capture pipeline.
    emit('audio:chunk', id, new ArrayBuffer(8));
    expect(stt.audio).toEqual([]);
  });
});

describe('ipc session:stop', () => {
  test('happy path: transcript, streamed deltas, then done with metrics', async () => {
    await setup();
    const id = await startedSession();
    const r = await invoke<Result<null>>('session:stop', id);
    expect(r).toEqual({ ok: true, value: null });

    expect(sentOn('stt:partial')).toEqual([
      { sessionId: id, text: 'What is your greatest strength?', isFinal: true },
    ]);
    expect(sentOn('llm:delta')).toEqual([
      { sessionId: id, delta: 'Hello ' },
      { sessionId: id, delta: 'world.' },
    ]);
    const done = sentOn('llm:done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      sessionId: id,
      transcript: 'What is your greatest strength?',
      answer: 'Hello world.',
    });
    const metrics = done[0]!['metrics'] as Record<string, number>;
    expect(metrics['sttFinalizeMs']).toBeGreaterThanOrEqual(0);
    expect(metrics['totalMs']).toBeGreaterThanOrEqual(metrics['firstTokenMs']!);
    expect(sentOn('session:error')).toEqual([]);
  });

  test('builds the provider from the stored profile', async () => {
    await setup();
    const id = await startedSession();
    await invoke('session:stop', id);
    // key, resume, jd, style — the whole grounding context for the answer.
    expect(anthropicArgs).toEqual([['ant-key', expect.objectContaining({
      resume: 'my resume', jobDescription: 'the jd', output: expect.objectContaining({ answerStyle: 'balanced' }),
    }), 'claude-haiku-4-5']]);
    expect(llm.prompts).toEqual(['What is your greatest strength?']);
  });

  test('a stop for an unknown session is refused, not swallowed', async () => {
    await setup();
    const r = await invoke<Result<null>>('session:stop', 12345);
    // This Result is the only way the renderer learns nothing is coming —
    // every other outcome arrives as an event.
    expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
    if (!r.ok) expect(r.error.message).toContain('already ended');
  });

  test('a missing key for the selected provider surfaces as a no_llm_key event', async () => {
    mocked.profile.llmProvider = 'groq'; // groqKey deliberately absent
    await setup();
    const id = await startedSession();
    const r = await invoke<Result<null>>('session:stop', id);
    // stop() took the session, so the invoke succeeds…
    expect(r).toEqual({ ok: true, value: null });
    // …and the failure arrives as the structured event the renderer renders.
    expect(sentOn('session:error')).toEqual([
      { sessionId: id, error: expect.objectContaining({ code: 'no_llm_key' }) },
    ]);
    expect(mocked.warmCalls).toContain('groq');
  });
});

describe('ipc session:ask', () => {
  test('happy path: question echoed as a final partial, then deltas, then done', async () => {
    await setup();
    const r = await invoke<Result<number>>('session:ask', '  Why this company?  ');
    expect(r.ok).toBe(true);
    const id = r.ok ? r.value : -1;

    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(1));
    // The typed question is trimmed and framed exactly like a recorded transcript.
    expect(sentOn('stt:partial')).toEqual([{ sessionId: id, text: 'Why this company?', isFinal: true }]);
    expect(sentOn('llm:done')[0]).toMatchObject({
      sessionId: id,
      transcript: 'Why this company?',
      answer: 'Hello world.',
    });
    // No STT ran, so billing any finalize time would fabricate latency.
    expect((sentOn('llm:done')[0]!['metrics'] as Record<string, number>)['sttFinalizeMs']).toBe(0);
  });

  test('rejects empty, whitespace-only, oversized and non-string questions as Results', async () => {
    await setup();
    for (const bad of ['', '   ', 'x'.repeat(8_001), 42, null, { q: 'hi' }]) {
      const r = await invoke<Result<number>>('session:ask', bad);
      expect(r).toMatchObject({ ok: false, error: { code: 'internal' } });
    }
    expect(sentOn('llm:done')).toEqual([]); // nothing ever reached the pipeline
  });
});

describe('ipc session:cancel', () => {
  test('cancels the live session and silences its events', async () => {
    await setup();
    const id = await startedSession();
    await invoke('session:cancel', id);
    expect(stt.aborted).toBe(true);
    const r = await invoke<Result<null>>('session:stop', id);
    expect(r).toMatchObject({ ok: false });
  });

  test('a malformed id neither throws nor kills the live session', async () => {
    // Regression: cancel used schema.parse, so a bad id rejected the invoke —
    // and the renderer calls cancel fire-and-forget, turning that into an
    // unhandled rejection.
    await setup();
    await startedSession();
    await expect(invoke('session:cancel', 'garbage')).resolves.toBeUndefined();
    await expect(invoke('session:cancel', -5)).resolves.toBeUndefined();
    expect(stt.aborted).toBe(false);
  });
});

describe('ipc window guards', () => {
  test('events after the window is destroyed are dropped, not crashed on', async () => {
    await setup();
    await startedSession();
    winDestroyed = true; // window closed mid-recording
    expect(() => stt.partialCb!('late words', false)).not.toThrow();
    expect(sentOn('stt:partial')).toEqual([]);
  });

  test('events with no window at all are dropped', async () => {
    await setup(() => null);
    await startedSession();
    expect(() => stt.partialCb!('late words', false)).not.toThrow();
    expect(sent).toEqual([]);
  });
});

describe('ipc context requests', () => {
  test('captures saved context and provider at record time despite later settings changes', async () => {
    await setup();
    const id = await startedSession();
    mocked.profile.jobDescription = 'Changed role';
    mocked.profile.answerStyle = 'detailed';
    mocked.profile.llmProvider = 'groq';
    await invoke('session:stop', id);
    expect(anthropicArgs[0]?.[1]).toMatchObject({ jobDescription: 'the jd', output: { answerStyle: 'balanced' } });
    expect(sentOn('llm:done')[0]?.context).toMatchObject({ jobDescription: 'the jd', output: { answerStyle: 'balanced' } });
    expect(mocked.warmCalls).toEqual(['anthropic', 'anthropic']);
  });

  test('regeneration uses original context even after the saved profile and output style change', async () => {
    await setup();
    await invoke('session:ask', 'Original question', { questionNote: 'Original note' });
    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(1));
    const snapshot = sentOn('llm:done')[0]?.context;
    mocked.profile.jobDescription = 'New role';
    mocked.profile.answerStyle = 'detailed';
    await invoke('session:ask', 'Original question', { snapshot });
    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(2));
    expect(anthropicArgs[1]?.[1]).toEqual(snapshot);
    expect(sentOn('llm:done')[1]?.context).toEqual(snapshot);
  });

  test('explicit follow-up and refinement reach only their own request', async () => {
    await setup();
    const followUp = { question: 'Earlier question', answer: 'Earlier suggestion' };
    await invoke('session:ask', 'Follow-up', { followUp, refinement: 'Shorten it', overrides: { tone: 'diplomatic' } });
    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(1));
    expect(anthropicArgs[0]?.[1]).toMatchObject({ relatedAnswer: followUp, refinement: 'Shorten it', output: { tone: 'diplomatic' } });
    await invoke('session:ask', 'Independent question');
    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(2));
    expect(anthropicArgs[1]?.[1]).not.toHaveProperty('relatedAnswer');
    expect(anthropicArgs[1]?.[1]).not.toHaveProperty('refinement');
  });

  test('invalid request options are actionable and leave the active recording intact', async () => {
    await setup();
    const id = await startedSession();
    for (const options of [
      { questionNote: 'x'.repeat(2001) }, { overrides: { tone: 'hostile' } },
      { followUp: { question: 'Q', answer: 'x'.repeat(3001) } }, { profileId: 'missing' },
      { snapshot: { output: {} } }, { unexpected: true },
    ]) {
      const asked = await invoke<Result<number>>('session:ask', 'Question', options);
      const started = await invoke<Result<number>>('session:start', options);
      expect(asked).toMatchObject({ ok: false, error: { code: 'internal' } });
      expect(started.ok).toBe(false);
    }
    expect(stt.aborted).toBe(false);
    const frame = new ArrayBuffer(4);
    emit('audio:chunk', id, frame);
    expect(stt.audio).toEqual([frame]);
  });

  test('validates profile arrays and output controls before persisting settings', async () => {
    const { createProfile, DEFAULT_OUTPUT } = await import('../src/shared/context');
    await setup();
    const profile = createProfile('client', 'client', 'Client');
    await invoke('settings:set', { contextProfiles: [profile], activeProfileId: 'client', outputDefaults: DEFAULT_OUTPUT });
    expect(mocked.patches).toHaveLength(1);
    for (const contextProfiles of [[], Array(21).fill(profile), [profile, profile], [{ ...profile, instructions: 'x'.repeat(8001) }]]) {
      await expect(invoke('settings:set', { contextProfiles })).rejects.toThrow();
    }
    await expect(invoke('settings:set', { outputDefaults: { ...DEFAULT_OUTPUT, format: 'invalid' } })).rejects.toThrow();
    expect(mocked.patches).toHaveLength(1);
  });
});

describe('merged personalization, model, and conversation requests', () => {
  test('captures model and global customization at record start despite settings edits', async () => {
    mocked.profile.anthropicModel = 'claude-sonnet-5';
    mocked.profile.personalProfile = 'Python developer';
    mocked.profile.customInstructions = 'Use practical examples';
    await setup();
    const id = await startedSession();
    mocked.profile.anthropicModel = 'claude-opus-5';
    mocked.profile.personalProfile = 'Edited profile';
    mocked.profile.customInstructions = 'Edited instructions';
    await invoke('session:stop', id);
    expect(anthropicArgs[0]).toEqual(['ant-key', expect.objectContaining({
      personalProfile: 'Python developer', customInstructions: 'Use practical examples',
    }), 'claude-sonnet-5']);
    expect(sentOn('llm:done')[0]?.context).toMatchObject({ personalProfile: 'Python developer', customInstructions: 'Use practical examples' });
  });

  test('routes explicit multi-turn context and legacy answerStyle into a frozen snapshot', async () => {
    await setup();
    const context = [{ question: 'What is caching?', answer: 'Reuse stored results.' }, { question: 'Give an example', answer: 'Cache an API response.' }];
    await invoke('session:ask', 'Show Python code', { context, answerStyle: 'detailed' });
    context[0]!.answer = 'Mutated after request';
    await vi.waitFor(() => expect(sentOn('llm:done')).toHaveLength(1));
    expect(anthropicArgs[0]?.[1]).toMatchObject({ conversation: [
      { question: 'What is caching?', answer: 'Reuse stored results.' },
      { question: 'Give an example', answer: 'Cache an API response.' },
    ], output: { answerStyle: 'detailed' } });
    expect(Object.isFrozen((anthropicArgs[0]?.[1] as { conversation: unknown }).conversation)).toBe(true);
  });

  test('rejects malformed conversation without replacing a live recording', async () => {
    await setup();
    await startedSession();
    for (const options of [
      { context: [{ question: 'Question', answer: '' }] },
      { context: Array.from({ length: 7 }, () => ({ question: 'Q', answer: 'A' })) },
      { context: [{ question: 'Q', answer: 'x'.repeat(20001) }] },
      { answerStyle: 'invalid' },
    ]) {
      expect(await invoke('session:ask', 'Explain more', options)).toMatchObject({ ok: false });
    }
    expect(stt.aborted).toBe(false);
    expect(anthropicArgs).toEqual([]);
  });

  test('validates customization, audio source, and model settings before persistence', async () => {
    await setup();
    const patch = { personalProfile: 'Engineer', customInstructions: 'Use Python', audioSource: 'microphone', anthropicModel: 'claude-sonnet-5', groqModel: 'llama-3.1-8b-instant' };
    await invoke('settings:set', patch);
    expect(mocked.patches).toEqual([patch]);
    for (const invalid of [
      { personalProfile: 'x'.repeat(12001) }, { customInstructions: 'x'.repeat(8001) },
      { audioSource: 'camera' }, { anthropicModel: 'arbitrary' }, { groqModel: 'arbitrary' },
    ]) await expect(invoke('settings:set', invalid)).rejects.toThrow();
    expect(mocked.patches).toHaveLength(1);
  });
});
