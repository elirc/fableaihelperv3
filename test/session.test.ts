import { describe, expect, test, vi } from 'vitest';
import type { AnswerMetrics, AskOptions, ContextSnapshot, AppError } from '../src/shared/types';
import {
  SessionManager,
  toAppError,
  type LlmProvider,
  type SessionEvents,
  type SttStream,
} from '../src/main/session';

// ---------- Fakes ----------
class FakeStt implements SttStream {
  partialCb: ((text: string, isFinal: boolean) => void) | null = null;
  errorCb: ((error: AppError) => void) | null = null;
  received: ArrayBuffer[] = [];
  aborted = false;
  transcript = 'what is your greatest strength';
  finalizeDelay = 0;

  onPartial(cb: (text: string, isFinal: boolean) => void): void {
    this.partialCb = cb;
  }
  onError(cb: (error: AppError) => void): void {
    this.errorCb = cb;
  }
  sendAudio(pcm: ArrayBuffer): void {
    this.received.push(pcm);
  }
  async finalize(): Promise<string> {
    if (this.finalizeDelay) await sleep(this.finalizeDelay);
    return this.transcript;
  }
  abort(): void {
    this.aborted = true;
  }

  /** Simulate the socket dying: what DeepgramStream reports to the manager. */
  die(code: AppError['code'] = 'stt_error', message = 'socket closed'): void {
    this.errorCb?.({ code, message });
  }
}

/**
 * DeepgramStream queues an error raised before onError() was registered and
 * delivers it synchronously *during* registration — the socket that dies
 * between connect() and wiring is exactly the case that queues one.
 */
class PreFailedStt extends FakeStt {
  override onError(cb: (error: AppError) => void): void {
    super.onError(cb);
    cb({ code: 'stt_error', message: 'socket closed before wiring' });
  }
}

function fakeLlm(answer = 'I am great at testing.', deltaDelay = 0): LlmProvider {
  return {
    async generate(_transcript, onDelta, signal) {
      if (deltaDelay) await sleep(deltaDelay);
      if (signal.aborted) throw new Error('aborted');
      onDelta(answer);
      return answer;
    },
  };
}

function collectEvents() {
  const log: Array<{ type: string; sessionId: number; data?: unknown }> = [];
  const events: SessionEvents = {
    onSttPartial: (sessionId, text, isFinal) => log.push({ type: 'partial', sessionId, data: { text, isFinal } }),
    onLlmDelta: (sessionId, delta) => log.push({ type: 'delta', sessionId, data: delta }),
    onLlmDone: (sessionId, transcript, answer, metrics) =>
      log.push({ type: 'done', sessionId, data: { transcript, answer, metrics } }),
    onError: (sessionId, error) => log.push({ type: 'error', sessionId, data: error }),
  };
  return { log, events };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until cond() holds. ask() resolves before its pipeline runs (the answer
 * streams in the background), so tests wait on the event log rather than on
 * the returned promise.
 */
async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

/** A promise whose resolution the test drives, for gating createStt(). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------- Tests ----------
describe('SessionManager', () => {
  test('happy path: audio routed, transcript finalized, answer streamed', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    const frame = new ArrayBuffer(8);
    mgr.audio(id, frame);
    expect(stt.received).toEqual([frame]);

    await mgr.stop(id);

    expect(log).toContainEqual({
      type: 'partial',
      sessionId: id,
      data: { text: 'what is your greatest strength', isFinal: true },
    });
    expect(log).toContainEqual({ type: 'delta', sessionId: id, data: 'I am great at testing.' });
    expect(log.at(-1)).toMatchObject({
      type: 'done',
      sessionId: id,
      data: { transcript: 'what is your greatest strength', answer: 'I am great at testing.' },
    });
  });

  test('starting a new session aborts the previous one', async () => {
    const first = new FakeStt();
    const second = new FakeStt();
    const streams = [first, second];
    const { events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => streams.shift()!, createLlm: () => fakeLlm(), events });

    const id1 = await mgr.start();
    const id2 = await mgr.start();

    expect(id2).toBeGreaterThan(id1);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);

    // Audio for the stale session is dropped.
    mgr.audio(id1, new ArrayBuffer(4));
    expect(first.received).toEqual([]);
  });

  test('an empty transcript reports no_speech', async () => {
    const stt = new FakeStt();
    stt.transcript = '   ';
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    await mgr.stop(id);

    const err = log.find((e) => e.type === 'error');
    expect((err?.data as AppError).code).toBe('no_speech');
  });

  test('LLM first-token timeout produces a structured error and aborts', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => fakeLlm('late answer', 200),
      events,
      timeouts: { llmFirstTokenMs: 30, llmTotalMs: 500 },
    });

    const id = await mgr.start();
    await mgr.stop(id);

    const err = log.find((e) => e.type === 'error');
    expect((err?.data as AppError).code).toBe('llm_first_token_timeout');
  });

  test('cancel during a slow answer suppresses late events', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => fakeLlm('answer', 100),
      events,
    });

    const id = await mgr.start();
    const stopping = mgr.stop(id);
    await sleep(20); // finalize resolves, LLM in flight
    mgr.cancel(id);
    await stopping;

    expect(log.find((e) => e.type === 'done')).toBeUndefined();
    // Aborts are silent — the user asked for the cancellation.
    expect(log.find((e) => e.type === 'error')).toBeUndefined();
  });

  test('createStt failure propagates from start()', async () => {
    const { events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => {
        throw { code: 'no_stt_key', message: 'missing' } satisfies AppError;
      },
      createLlm: () => fakeLlm(),
      events,
    });
    await expect(mgr.start()).rejects.toMatchObject({ code: 'no_stt_key' });
  });

  test('stop on an unknown session is a no-op', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => fakeLlm(), events });
    await mgr.stop(999);
    expect(log).toEqual([]);
  });

  test('cancel on an unknown session leaves the live one untouched', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    mgr.cancel(999);

    expect(stt.aborted).toBe(false);
    const frame = new ArrayBuffer(8);
    mgr.audio(id, frame);
    expect(stt.received).toEqual([frame]);
    expect(log).toEqual([]);
  });
});

// Every other outcome of stop() reaches the renderer as an event. A stop the
// manager silently ignores is therefore one the caller waits on forever, so
// this return value is load-bearing: it is the only thing between a session
// that is already gone and a UI stuck on "Finalizing…" for the rest of the
// interview. Caught by review — both sides were individually correct.
describe('SessionManager stop() reports whether it took the session', () => {
  const managerWith = (stt: SttStream) => {
    const { log, events } = collectEvents();
    return { log, mgr: new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events }) };
  };

  test('returns true for the live session', async () => {
    const { mgr } = managerWith(new FakeStt());
    const id = await mgr.start();
    expect(await mgr.stop(id)).toBe(true);
  });

  test('returns false for a session that never existed', async () => {
    const { mgr } = managerWith(new FakeStt());
    expect(await mgr.stop(999)).toBe(false);
  });

  test('returns false once an STT death has torn the session down', async () => {
    const stt = new FakeStt();
    const { mgr } = managerWith(stt);
    const id = await mgr.start();

    stt.die(); // the socket dies while the user is still speaking

    // The renderer can reach this point still believing it is recording — the
    // error is tagged with a session id it may not have adopted yet, and the
    // level meter runs on local audio, so the window looks alive. It presses
    // Stop and must be told, not left waiting for an answer that cannot come.
    expect(await mgr.stop(id)).toBe(false);
  });

  test('returns false for a second stop while the first is still running', async () => {
    const stt = new FakeStt();
    stt.finalizeDelay = 20;
    const { mgr } = managerWith(stt);
    const id = await mgr.start();

    const first = mgr.stop(id);
    expect(await mgr.stop(id)).toBe(false); // the in-flight stop already owns it
    expect(await first).toBe(true);
  });

  test('returns false for a stop after the session already completed', async () => {
    const { mgr } = managerWith(new FakeStt());
    const id = await mgr.start();
    expect(await mgr.stop(id)).toBe(true);
    // The answer is done and the slot released; a stale Stop press must be
    // told the session is gone, not silently swallowed.
    expect(await mgr.stop(id)).toBe(false);
  });
});

// The product is a latency claim, so the numbers behind it are a tested contract.
describe('SessionManager answer metrics', () => {
  // Long enough that "recording time leaked into the metric" can never be
  // confused with the suite being busy. The earlier 30ms gap put the correct
  // reading (~40ms) and the buggy one (~70ms) inside each other's jitter, and
  // the test flaked under parallel load at 75ms and 81ms.
  const RECORDING_MS = 300;

  test('measures finalize, first token and total from the moment stop() is called', async () => {
    const stt = new FakeStt();
    stt.finalizeDelay = 40;
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => fakeLlm('answer', 40), // first delta ~40ms after finalize
      events,
    });

    const id = await mgr.start();
    await sleep(RECORDING_MS); // time spent recording must NOT be counted
    await mgr.stop(id);

    const done = log.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const m = (done!.data as { metrics: AnswerMetrics }).metrics;

    // Clock starts at stop(), not at start(). This asserts against a real wall
    // clock, so the correct and incorrect readings have to sit further apart
    // than scheduler jitter on a loaded suite — hence a long recording rather
    // than a tight ceiling on the ~40ms finalize. A clock started at start()
    // reads >= RECORDING_MS; a correct one reads ~40ms, an order of magnitude
    // clear of both the bound and the noise.
    expect(m.sttFinalizeMs).toBeGreaterThanOrEqual(30);
    expect(m.sttFinalizeMs).toBeLessThan(RECORDING_MS);
    // Monotonic: finalize <= first token <= total.
    expect(m.firstTokenMs).toBeGreaterThanOrEqual(m.sttFinalizeMs);
    expect(m.totalMs).toBeGreaterThanOrEqual(m.firstTokenMs);
    expect(m.firstTokenMs).toBeGreaterThanOrEqual(70);
  });

  test('a provider that never streams a delta reports first token at completion, not 0', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const silent: LlmProvider = { async generate() { return 'whole answer at once'; } };
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => silent, events });

    const id = await mgr.start();
    await mgr.stop(id);

    const m = (log.find((e) => e.type === 'done')!.data as { metrics: AnswerMetrics }).metrics;
    // 0 would render as an instant answer — a metric that lies about the thing
    // this app is judged on.
    expect(m.firstTokenMs).toBe(m.totalMs);
  });
});

describe('SessionManager STT stream errors', () => {
  test('a socket death while recording surfaces as an error and tears the session down', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    stt.die('stt_error', 'websocket closed unexpectedly');

    expect(log).toEqual([
      { type: 'error', sessionId: id, data: { code: 'stt_error', message: 'websocket closed unexpectedly' } },
    ]);
    expect(stt.aborted).toBe(true);

    // The session is gone: audio and stop are no-ops, no truncated answer.
    mgr.audio(id, new ArrayBuffer(4));
    expect(stt.received).toEqual([]);
    await mgr.stop(id);
    expect(log.find((e) => e.type === 'done')).toBeUndefined();
  });

  test('a socket death during finalize wins over the truncated transcript', async () => {
    const stt = new FakeStt();
    stt.finalizeDelay = 50;
    stt.transcript = 'what is your grea'; // the truncated tail we must not answer
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    const stopping = mgr.stop(id);
    await sleep(10);
    stt.die();
    await stopping;

    expect(log.filter((e) => e.type === 'error')).toHaveLength(1);
    expect((log[0]!.data as AppError).code).toBe('stt_error');
    expect(log.find((e) => e.type === 'done')).toBeUndefined();
    expect(log.find((e) => e.type === 'delta')).toBeUndefined();
  });

  test('a late STT error does not kill an answer that is already streaming', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => fakeLlm('answer', 50),
      events,
    });

    const id = await mgr.start();
    const stopping = mgr.stop(id);
    await sleep(10); // transcript is final, LLM streaming
    stt.die(); // Deepgram closing its socket now is expected, not a failure
    await stopping;

    expect(log.find((e) => e.type === 'error')).toBeUndefined();
    expect(log.at(-1)).toMatchObject({ type: 'done', sessionId: id });
  });

  test('an error queued before wiring rejects start before the renderer adopts its id', async () => {
    const stt = new PreFailedStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    await expect(mgr.start()).rejects.toEqual({ code: 'stt_error', message: 'socket closed before wiring' });
    expect(log).toEqual([]);
    expect(stt.aborted).toBe(true);
    mgr.audio(1, new ArrayBuffer(4));
    expect(stt.received).toEqual([]);
  });

  test('an error from a session that was already replaced is ignored', async () => {
    const first = new FakeStt();
    const second = new FakeStt();
    const streams = [first, second];
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => streams.shift()!, createLlm: () => fakeLlm(), events });

    const id1 = await mgr.start();
    await mgr.start();
    first.die(); // the old socket dying is the *consequence* of us aborting it

    expect(log.find((e) => e.sessionId === id1)).toBeUndefined();
  });
});

describe('SessionManager start() staleness', () => {
  test('a start superseded while connecting is discarded, and the newest one wins', async () => {
    const first = new FakeStt();
    const second = new FakeStt();
    const gates = [deferred<SttStream>(), deferred<SttStream>()];
    let n = 0;
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: () => gates[n++]!.promise,
      createLlm: () => fakeLlm(),
      events,
    });

    const starting1 = mgr.start(); // in flight: no active session yet
    const starting2 = mgr.start();

    // The newer connection completes first, then the older one arrives late.
    gates[1]!.resolve(second);
    const id2 = await starting2;
    gates[0]!.resolve(first);

    await expect(starting1).rejects.toMatchObject({ code: 'aborted' });
    // The superseded stream must be torn down, not left holding a live socket.
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);

    // The winner is fully wired: its partials reach the renderer.
    second.partialCb?.('hello', false);
    expect(log).toContainEqual({ type: 'partial', sessionId: id2, data: { text: 'hello', isFinal: false } });
  });

  test('a superseded start does not steal the active session from the newer one', async () => {
    const first = new FakeStt();
    const second = new FakeStt();
    const gates = [deferred<SttStream>(), deferred<SttStream>()];
    let n = 0;
    const { events } = collectEvents();
    const mgr = new SessionManager({
      createStt: () => gates[n++]!.promise,
      createLlm: () => fakeLlm(),
      events,
    });

    const starting1 = mgr.start();
    const starting2 = mgr.start();

    gates[1]!.resolve(second);
    const id2 = await starting2;
    gates[0]!.resolve(first);
    await expect(starting1).rejects.toMatchObject({ code: 'aborted' });

    // Audio still reaches the session the user is actually recording into.
    const frame = new ArrayBuffer(8);
    mgr.audio(id2, frame);
    expect(second.received).toEqual([frame]);
    expect(first.received).toEqual([]);
  });
});

// ask() feeds a typed question straight into the LLM pipeline, reusing the
// recorded-session event contract: the renderer must not be able to tell the
// difference except that sttFinalizeMs is 0.
describe('SessionManager ask()', () => {
  test('happy path: resolves with the id, then partial → deltas → done in order', async () => {
    const { log, events } = collectEvents();
    const llm: LlmProvider = {
      async generate(_t, onDelta) {
        onDelta('I pair ');
        await sleep(10);
        onDelta('well.');
        return 'I pair well.';
      },
    };
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => llm, events });

    const id = await mgr.ask('  tell me about teamwork  ');
    // Events land only after the caller holds the session id — the renderer
    // needs it to route them. Nothing may have been emitted yet.
    expect(log).toEqual([]);

    await until(() => log.some((e) => e.type === 'done'));
    // The question is trimmed and goes out as an already-final transcript.
    expect(log[0]).toEqual({
      type: 'partial',
      sessionId: id,
      data: { text: 'tell me about teamwork', isFinal: true },
    });
    expect(log.filter((e) => e.type === 'delta').map((e) => e.data)).toEqual(['I pair ', 'well.']);
    expect(log.at(-1)).toMatchObject({
      type: 'done',
      sessionId: id,
      data: { transcript: 'tell me about teamwork', answer: 'I pair well.' },
    });
  });

  test('metrics: sttFinalizeMs is 0, first token measured from ask() to the first delta', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => fakeLlm('answer', 40), // first delta ~40ms after ask
      events,
    });

    await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'done'));

    const m = (log.find((e) => e.type === 'done')!.data as { metrics: AnswerMetrics }).metrics;
    // There was no STT stage; anything but 0 would fabricate latency.
    expect(m.sttFinalizeMs).toBe(0);
    // The clock starts at ask() entry, so the ~40ms delta delay is visible.
    expect(m.firstTokenMs).toBeGreaterThanOrEqual(30);
    expect(m.totalMs).toBeGreaterThanOrEqual(m.firstTokenMs);
  });

  test('a provider that never streams a delta reports first token at completion, not 0', async () => {
    const { log, events } = collectEvents();
    const silent: LlmProvider = {
      async generate() {
        await sleep(20);
        return 'whole answer at once';
      },
    };
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => silent, events });

    await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'done'));

    const m = (log.find((e) => e.type === 'done')!.data as { metrics: AnswerMetrics }).metrics;
    // Same rule as a recorded stop: 0 would render as an instant answer.
    expect(m.firstTokenMs).toBe(m.totalMs);
    expect(m.firstTokenMs).toBeGreaterThan(0);
  });

  test('ask supersedes an active recording session', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const recId = await mgr.start();
    const askId = await mgr.ask('typed question');

    expect(askId).toBeGreaterThan(recId);
    expect(stt.aborted).toBe(true);
    // The recording session is gone: its audio is dropped and its stream's
    // late partials never reach the renderer.
    mgr.audio(recId, new ArrayBuffer(4));
    expect(stt.received).toEqual([]);
    stt.partialCb?.('late words', false);
    expect(log.filter((e) => e.sessionId === recId)).toEqual([]);

    await until(() => log.some((e) => e.type === 'done'));
    expect(log.at(-1)).toMatchObject({ type: 'done', sessionId: askId });
  });

  test('a new start() supersedes an in-flight ask silently', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => fakeLlm('slow answer', 100),
      events,
    });

    const askId = await mgr.ask('typed question');
    await until(() => log.some((e) => e.type === 'partial' && e.sessionId === askId)); // LLM now in flight
    const recId = await mgr.start();

    await sleep(150); // long enough for the aborted LLM to have surfaced anything

    // The superseded ask produced no answer and no error — the user moved on.
    expect(log.filter((e) => e.sessionId === askId && e.type !== 'partial')).toEqual([]);
    // The new recording session is live and receiving audio.
    const frame = new ArrayBuffer(8);
    mgr.audio(recId, frame);
    expect(stt.received).toEqual([frame]);
  });

  test('an in-flight start() loses to a subsequent ask()', async () => {
    const stt = new FakeStt();
    const gate = deferred<SttStream>();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: () => gate.promise, createLlm: () => fakeLlm(), events });

    const starting = mgr.start(); // still connecting when the user types instead
    const askId = await mgr.ask('typed question');
    gate.resolve(stt); // the recording connection arrives too late

    await expect(starting).rejects.toMatchObject({ code: 'aborted' });
    expect(stt.aborted).toBe(true); // its socket is not left open

    await until(() => log.some((e) => e.type === 'done'));
    expect(log.at(-1)).toMatchObject({ type: 'done', sessionId: askId });
  });

  test('cancel mid-ask aborts silently', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => fakeLlm('answer', 100),
      events,
    });

    const id = await mgr.ask('typed question');
    await until(() => log.length > 0); // partial emitted, LLM in flight
    mgr.cancel(id);
    await sleep(150);

    // Aborts are silent — the user asked for the cancellation.
    expect(log.find((e) => e.type === 'done')).toBeUndefined();
    expect(log.find((e) => e.type === 'error')).toBeUndefined();
  });

  test('an LLM failure surfaces as a structured error event', async () => {
    const { log, events } = collectEvents();
    const failing: LlmProvider = {
      async generate() {
        throw { code: 'llm_auth', message: 'bad key' } satisfies AppError;
      },
    };
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => failing, events });

    const id = await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'error'));

    expect(log.at(-1)).toEqual({ type: 'error', sessionId: id, data: { code: 'llm_auth', message: 'bad key' } });
    expect(log.find((e) => e.type === 'done')).toBeUndefined();
  });

  test('a createLlm failure (e.g. missing key) arrives as an event, not a rejection', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => {
        throw { code: 'no_llm_key', message: 'missing' } satisfies AppError;
      },
      events,
    });

    // ask() resolves with the id first — the failure happens in the background
    // pipeline and must reach the renderer through the event stream it watches.
    const id = await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'error'));
    expect(log.at(-1)).toEqual({ type: 'error', sessionId: id, data: { code: 'no_llm_key', message: 'missing' } });
  });

  test('first-token timeout maps to llm_first_token_timeout', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => fakeLlm('late answer', 200),
      events,
      timeouts: { llmFirstTokenMs: 30, llmTotalMs: 500 },
    });

    const id = await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'error'));

    expect(log.at(-1)!.sessionId).toBe(id);
    expect((log.at(-1)!.data as AppError).code).toBe('llm_first_token_timeout');
  });

  test('total timeout maps to llm_timeout even after tokens have streamed', async () => {
    const { log, events } = collectEvents();
    const hanging: LlmProvider = {
      generate(_t, onDelta, signal) {
        onDelta('starts fine ');
        return new Promise((_res, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    };
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => hanging,
      events,
      timeouts: { llmFirstTokenMs: 1_000, llmTotalMs: 60 },
    });

    const id = await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'error'));

    expect(log.at(-1)!.sessionId).toBe(id);
    expect((log.at(-1)!.data as AppError).code).toBe('llm_timeout');
  });

  test('whitespace-only text is rejected without touching the active session', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const recId = await mgr.start();
    await expect(mgr.ask('   \n\t ')).rejects.toMatchObject({ code: 'internal' });

    // Nothing was emitted for a session that never existed, and the invalid
    // ask must not have killed the recording in progress.
    expect(log).toEqual([]);
    expect(stt.aborted).toBe(false);
    const frame = new ArrayBuffer(8);
    mgr.audio(recId, frame);
    expect(stt.received).toEqual([frame]);
  });

  test('stop() on an ask session returns false — there is no recording to stop', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => fakeLlm('answer', 50),
      events,
    });

    const id = await mgr.ask('question');
    expect(await mgr.stop(id)).toBe(false);

    // The rejected stop must not have disturbed the answer in flight.
    await until(() => log.some((e) => e.type === 'done'));
    expect(log.at(-1)).toMatchObject({ type: 'done', sessionId: id });
  });

  test('audio() for an ask session is a silent no-op', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => fakeLlm(), events });

    const id = await mgr.ask('question');
    expect(() => mgr.audio(id, new ArrayBuffer(8))).not.toThrow();

    await until(() => log.some((e) => e.type === 'done'));
    expect(log.find((e) => e.type === 'error')).toBeUndefined();
  });

  test('a finished ask releases the slot for the next session', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const askId = await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'done'));
    mgr.cancel(askId); // stale cancel after completion is a no-op

    const recId = await mgr.start();
    expect(stt.aborted).toBe(false); // nothing lingered to be cancelled
    const frame = new ArrayBuffer(8);
    mgr.audio(recId, frame);
    expect(stt.received).toEqual([frame]);
  });
});

describe('toAppError', () => {
  test('passes structured errors through', () => {
    const e: AppError = { code: 'llm_auth', message: 'bad key' };
    expect(toAppError(e)).toEqual(e);
  });

  test('wraps plain errors with the fallback code', () => {
    expect(toAppError(new Error('boom'), 'llm_http')).toEqual({ code: 'llm_http', message: 'boom' });
  });

  test('wraps a bare string throw with the fallback code and the string as message', () => {
    // `throw 'text'` exists in the wild (and in dependency code); it must reach
    // the renderer as a structured error, not crash the mapper.
    expect(toAppError('socket hang up')).toEqual({ code: 'internal', message: 'socket hang up' });
  });

  test('wraps null and undefined without crashing', () => {
    // `'code' in err` throws on null; the null-check guard is what this pins.
    expect(toAppError(null)).toEqual({ code: 'internal', message: 'null' });
    expect(toAppError(undefined, 'stt_error')).toEqual({ code: 'stt_error', message: 'undefined' });
  });

  test('an object with a non-string code is not mistaken for an AppError', () => {
    // An HTTP-ish `{ code: 500 }` shape must not smuggle a number into a field
    // the renderer switches on as a string.
    expect(toAppError({ code: 500, message: 'server error' }, 'llm_http')).toEqual({
      code: 'llm_http',
      message: '[object Object]',
    });
  });

  test('an object missing either half of the pair falls to the fallback', () => {
    expect(toAppError({ code: 'llm_auth' }, 'llm_http')).toEqual({ code: 'llm_http', message: '[object Object]' });
    expect(toAppError({ message: 'no code here' }, 'llm_http')).toEqual({
      code: 'llm_http',
      message: '[object Object]',
    });
    expect(toAppError({ code: 'llm_auth', message: 42 }, 'llm_http')).toEqual({
      code: 'llm_http',
      message: '[object Object]',
    });
  });

  test('a Node-style Error carrying a string code passes through structured', () => {
    // Documented behavior, not an accident: fs/net errors carry string codes
    // (ENOENT, ECONNRESET). They satisfy the structural check, so the code
    // survives into the event and the renderer's unknown-code fallback renders
    // the message — strictly more diagnostic than flattening to 'internal'.
    const nodeErr = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    expect(toAppError(nodeErr)).toEqual({ code: 'ECONNRESET', message: 'connect ECONNRESET' });
  });
});

// Interleavings a fast-fingered user (or a laggy network) can actually produce.
// Each one pins a different corner of the one-live-session invariant: whoever
// acted last owns the slot, and every loser goes silent instead of leaking
// events, sockets, or a stolen `active`.
describe('SessionManager concurrency stress', () => {
  test('a second ask() supersedes the first mid-stream; only the newest answers', async () => {
    const { log, events } = collectEvents();
    let call = 0;
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      // First ask gets a slow provider so the second lands mid-stream.
      createLlm: () => (call++ === 0 ? fakeLlm('first answer', 100) : fakeLlm('second answer', 10)),
      events,
    });

    const id1 = await mgr.ask('first question');
    await until(() => log.some((e) => e.type === 'partial' && e.sessionId === id1)); // LLM 1 in flight
    const id2 = await mgr.ask('second question');

    await until(() => log.some((e) => e.type === 'done'));
    await sleep(150); // long enough for the aborted first LLM to have surfaced anything

    // The superseded ask must vanish silently: no answer, no error — the user
    // re-asked and only the new answer may paint.
    expect(log.filter((e) => e.sessionId === id1 && e.type !== 'partial')).toEqual([]);
    expect(log.filter((e) => e.type === 'done')).toEqual([
      expect.objectContaining({ sessionId: id2, data: expect.objectContaining({ answer: 'second answer' }) }),
    ]);
  });

  test('cancel racing a stop mid-finalize suppresses the entire pipeline', async () => {
    const stt = new FakeStt();
    stt.finalizeDelay = 50;
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    const stopping = mgr.stop(id);
    await sleep(10); // finalize in flight, transcript not yet final
    mgr.cancel(id);

    // The stop legitimately took the session before the cancel — true is the
    // honest answer even though the pipeline will now go quiet.
    expect(await stopping).toBe(true);
    expect(stt.aborted).toBe(true);
    await sleep(100); // let the orphaned finalize resolve into the stale check

    // Not even the final partial may fire: the user cancelled before the
    // transcript existed, so nothing it fed may reach the renderer.
    expect(log).toEqual([]);
  });

  test('a stop that lands while start() is still connecting takes nothing and spares the session', async () => {
    const stt = new FakeStt();
    const gate = deferred<SttStream>();
    const { events } = collectEvents();
    const mgr = new SessionManager({ createStt: () => gate.promise, createLlm: () => fakeLlm(), events });

    const starting = mgr.start();
    // The hotkey toggles record/stop, so a stop can race the connect. The id
    // the session WILL get is 1 (first session of this manager) — even that
    // must be refused while nothing is installed yet.
    expect(await mgr.stop(1)).toBe(false);

    gate.resolve(stt);
    const id = await starting;
    // The refused stop did not poison the session: it records and stops normally.
    const frame = new ArrayBuffer(8);
    mgr.audio(id, frame);
    expect(stt.received).toEqual([frame]);
    expect(await mgr.stop(id)).toBe(true);
  });

  test('a new start() while the previous stop is mid-LLM silences that answer', async () => {
    const first = new FakeStt();
    const second = new FakeStt();
    const streams = [first, second];
    const { log, events } = collectEvents();
    const mgr = new SessionManager({
      createStt: async () => streams.shift()!,
      createLlm: () => fakeLlm('slow answer', 100),
      events,
    });

    const id1 = await mgr.start();
    const stopping = mgr.stop(id1);
    await until(() => log.some((e) => e.type === 'partial' && e.sessionId === id1)); // LLM in flight
    const id2 = await mgr.start();
    expect(await stopping).toBe(true);
    await sleep(150); // the aborted LLM settles

    // The half-answered question dies silently; the new recording is live.
    expect(log.filter((e) => e.sessionId === id1 && e.type !== 'partial')).toEqual([]);
    const frame = new ArrayBuffer(8);
    mgr.audio(id2, frame);
    expect(second.received).toEqual([frame]);
    expect(first.aborted).toBe(true);
  });

  test('an ask() while the previous stop is mid-LLM pivots to the typed question', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    let call = 0;
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => (call++ === 0 ? fakeLlm('recorded answer', 100) : fakeLlm('typed answer', 10)),
      events,
    });

    const recId = await mgr.start();
    const stopping = mgr.stop(recId);
    await until(() => log.some((e) => e.type === 'partial' && e.sessionId === recId)); // LLM in flight
    const askId = await mgr.ask('typed question');
    expect(await stopping).toBe(true);

    await until(() => log.some((e) => e.type === 'done'));
    await sleep(150);

    // Only the typed question answers; the recorded one is silent past its partial.
    expect(log.filter((e) => e.sessionId === recId && e.type !== 'partial')).toEqual([]);
    expect(log.filter((e) => e.type === 'done')).toEqual([
      expect.objectContaining({ sessionId: askId, data: expect.objectContaining({ answer: 'typed answer' }) }),
    ]);
    expect(stt.aborted).toBe(true);
  });

  test('audio sent after stop() was called is dropped, not fed into the finalize', async () => {
    const stt = new FakeStt();
    stt.finalizeDelay = 50;
    const { events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });

    const id = await mgr.start();
    const beforeStop = new ArrayBuffer(4);
    mgr.audio(id, beforeStop);
    const stopping = mgr.stop(id);
    mgr.audio(id, new ArrayBuffer(8)); // straggler frame from the capture pipeline

    await stopping;
    // Frames after stop can no longer influence the transcript; forwarding them
    // would race the CloseStream flush in the real Deepgram stream.
    expect(stt.received).toEqual([beforeStop]);
  });
});

describe('SessionManager timeout interplay', () => {
  test('total timeout during a recorded session maps to llm_timeout after tokens streamed', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    const hanging: LlmProvider = {
      generate(_t, onDelta, signal) {
        onDelta('starts fine ');
        return new Promise((_res, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    };
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => hanging,
      events,
      timeouts: { llmFirstTokenMs: 1_000, llmTotalMs: 60 },
    });

    const id = await mgr.start();
    await mgr.stop(id);

    // The ask() path pins this already; the recorded path must share the same
    // deadline machinery, not a copy without one.
    expect(log.at(-1)!.sessionId).toBe(id);
    expect((log.at(-1)!.data as AppError).code).toBe('llm_timeout');
    expect(log.find((e) => e.type === 'done')).toBeUndefined();
  });

  test('the first-token timeout is disarmed by the first delta', async () => {
    const stt = new FakeStt();
    const { log, events } = collectEvents();
    // Delta immediately, then a long quiet stretch that crosses the
    // first-token deadline before completing.
    const llm: LlmProvider = {
      async generate(_t, onDelta) {
        onDelta('first ');
        await sleep(150);
        return 'first token then silence';
      },
    };
    const mgr = new SessionManager({
      createStt: async () => stt,
      createLlm: () => llm,
      events,
      timeouts: { llmFirstTokenMs: 50, llmTotalMs: 2_000 },
    });

    const id = await mgr.start();
    await mgr.stop(id);

    // If the timer's gotFirstToken check regressed, this answer would be
    // killed at 50ms despite having already painted its first word.
    expect(log.find((e) => e.type === 'error')).toBeUndefined();
    expect(log.at(-1)).toMatchObject({ type: 'done', sessionId: id });
  });

  test('deltas emitted after the total timeout fired are suppressed', async () => {
    const { log, events } = collectEvents();
    const leaky: LlmProvider = {
      generate(_t, onDelta, signal) {
        onDelta('before');
        return new Promise((_res, reject) => {
          signal.addEventListener('abort', () => {
            // A real stream can have a decoded chunk in hand when the abort
            // lands; it must not paint into the error state.
            onDelta(' after the deadline');
            reject(new Error('aborted'));
          });
        });
      },
    };
    const mgr = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: () => leaky,
      events,
      timeouts: { llmFirstTokenMs: 1_000, llmTotalMs: 60 },
    });

    await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'error'));

    expect(log.filter((e) => e.type === 'delta').map((e) => e.data)).toEqual(['before']);
    expect((log.at(-1)!.data as AppError).code).toBe('llm_timeout');
  });
});

describe('SessionManager LLM abort semantics', () => {
  test("a provider throw carrying code 'aborted' stays silent even without a signal abort", async () => {
    const { log, events } = collectEvents();
    const failing: LlmProvider = {
      async generate() {
        // Providers map their own cancellation shapes to code 'aborted'
        // (e.g. APIUserAbortError). The manager must honor the code itself,
        // not only its own signal state, or those would toast as errors.
        throw { code: 'aborted', message: 'Answer cancelled.' } satisfies AppError;
      },
    };
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => failing, events });

    const id = await mgr.ask('question');
    await until(() => log.some((e) => e.type === 'partial' && e.sessionId === id));
    await sleep(50); // let the rejection travel the pipeline

    expect(log.filter((e) => e.type === 'error' || e.type === 'done')).toEqual([]);

    // And the slot was still released: the next session starts clean.
    await expect(mgr.start()).resolves.toBeGreaterThan(id);
  });
});

describe('immutable answer context', () => {
  test('recording captures context and provider before STT connects and reports that snapshot on completion', async () => {
    const { legacyContext } = await import('../src/main/prompt');
    const snapshot = legacyContext('Original resume', 'Original role', 'brief');
    snapshot.relatedAnswer = { question: 'Original question', answer: 'Original suggestion' };
    const gate = deferred<SttStream>();
    const stt = new FakeStt();
    const { events } = collectEvents();
    let captured: unknown;
    let doneContext: unknown;
    let provider: unknown;
    events.onLlmDone = (_id, _q, _a, _m, context) => { doneContext = context; };
    const mgr = new SessionManager({ createStt: () => gate.promise,
      createLlm: (context, selected) => { captured = context; provider = selected; return fakeLlm(); }, events });
    const started = mgr.start(snapshot, 'groq');
    snapshot.resume = 'Changed resume';
    snapshot.output.answerStyle = 'detailed';
    snapshot.relatedAnswer.answer = 'Changed suggestion';
    gate.resolve(stt);
    await mgr.stop(await started);
    expect(captured).toMatchObject({ resume: 'Original resume', output: { answerStyle: 'brief' }, relatedAnswer: { answer: 'Original suggestion' } });
    expect(provider).toBe('groq');
    expect(doneContext).toBe(captured);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen((captured as { output: unknown }).output)).toBe(true);
  });

  test('typed asks snapshot notes before the deferred pipeline runs', async () => {
    const { legacyContext } = await import('../src/main/prompt');
    const snapshot = legacyContext('', '', 'balanced');
    snapshot.questionNote = 'Original note';
    const { log, events } = collectEvents();
    let captured: unknown;
    const mgr = new SessionManager({ createStt: async () => new FakeStt(),
      createLlm: (context) => { captured = context; return fakeLlm(); }, events });
    await mgr.ask('Question', snapshot);
    snapshot.questionNote = 'Edited after submission';
    await until(() => log.some((event) => event.type === 'done'));
    expect(captured).toMatchObject({ questionNote: 'Original note' });
  });

  test('malformed and oversized context cannot supersede a live recording', async () => {
    const { legacyContext } = await import('../src/main/prompt');
    const stt = new FakeStt();
    const { events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });
    const id = await mgr.start();
    const invalid = { ...legacyContext('', '', 'balanced'), questionNote: 'x'.repeat(2001) };
    await expect(mgr.ask('Question', invalid)).rejects.toBeDefined();
    await expect(mgr.start(invalid)).rejects.toBeDefined();
    await expect(mgr.ask('x'.repeat(8001))).rejects.toMatchObject({ code: 'internal' });
    const audio = new ArrayBuffer(4);
    mgr.audio(id, audio);
    expect(stt.received).toEqual([audio]);
    expect(stt.aborted).toBe(false);
  });

  test('recorded transcript size is bounded before reaching the answer provider', async () => {
    const stt = new FakeStt();
    stt.transcript = 'x'.repeat(32001);
    const { log, events } = collectEvents();
    let created = false;
    const mgr = new SessionManager({ createStt: async () => stt,
      createLlm: () => { created = true; return fakeLlm(); }, events });
    await mgr.stop(await mgr.start());
    expect(created).toBe(false);
    expect(stt.aborted).toBe(true);
    expect(log).toContainEqual(expect.objectContaining({ type: 'error', data: expect.objectContaining({ code: 'internal' }) }));
  });
});

describe('combined request budget', () => {
  test('individually valid fields cannot exceed the combined request cap or supersede the active session', async () => {
    const { legacyContext } = await import('../src/main/prompt');
    const snapshot = legacyContext('r'.repeat(200000), 'j'.repeat(200000), 'balanced');
    snapshot.background = 'b'.repeat(16000);
    snapshot.instructions = 'i'.repeat(8000);
    snapshot.questionNote = 'n'.repeat(2000);
    snapshot.refinement = 'f'.repeat(1000);
    snapshot.relatedAnswer = { question: 'q'.repeat(1000), answer: 'a'.repeat(3000) };
    const stt = new FakeStt();
    const { events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });
    const id = await mgr.start();
    await expect(mgr.ask('q'.repeat(8000), snapshot)).rejects.toMatchObject({ code: 'internal' });
    const frame = new ArrayBuffer(2);
    mgr.audio(id, frame);
    expect(stt.received).toEqual([frame]);
    expect(stt.aborted).toBe(false);
  });
});

describe('terminal resource cleanup', () => {
  test('finalize rejection aborts the stream and emits exactly one error', async () => {
    const stt = new FakeStt();
    stt.finalize = async () => { throw { code: 'stt_timeout', message: 'No final transcript' }; };
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => stt, createLlm: () => fakeLlm(), events });
    const id = await mgr.start();
    await mgr.stop(id);
    expect(stt.aborted).toBe(true);
    expect(log).toEqual([{ type: 'error', sessionId: id, data: { code: 'stt_timeout', message: 'No final transcript' } }]);
    expect(await mgr.stop(id)).toBe(false);
  });

  test('cancelling a provider that ignores abort removes timeout handles immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { log, events } = collectEvents();
      const mgr = new SessionManager({ createStt: async () => new FakeStt(),
        createLlm: () => ({ generate: () => new Promise<string>(() => {}) }), events });
      const id = await mgr.ask('Question');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(vi.getTimerCount()).toBe(2);
      mgr.cancel(id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(vi.getTimerCount()).toBe(0);
      expect(log.filter((event) => event.type === 'error')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a synchronous provider failure removes timers and reports one terminal error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { log, events } = collectEvents();
      const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => ({
        generate() { throw new Error('Synchronous provider failure'); },
      }), events });
      await mgr.ask('Question');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(vi.getTimerCount()).toBe(0);
      expect(log.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(log.at(-1)?.data).toMatchObject({ code: 'llm_http', message: 'Synchronous provider failure' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SessionManager usage threading', () => {
  const USAGE = {
    model: 'claude-haiku-4-5',
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estCostUsd: 0.003,
  };

  function usageLlm(): LlmProvider {
    return {
      async generate(_transcript, onDelta, _signal, onUsage) {
        onDelta('answer');
        onUsage?.(USAGE);
        return 'answer';
      },
    };
  }

  test('usage reported by the provider lands on the done metrics', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: usageLlm, events });
    const id = await mgr.start();
    await mgr.stop(id);
    const m = (log.find((e) => e.type === 'done')!.data as { metrics: AnswerMetrics }).metrics;
    expect(m.usage).toEqual(USAGE);
  });

  test('ask() sessions carry usage too', async () => {
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: usageLlm, events });
    await mgr.ask('what are react hooks');
    await until(() => log.some((e) => e.type === 'done'));
    const m = (log.find((e) => e.type === 'done')!.data as { metrics: AnswerMetrics }).metrics;
    expect(m.usage).toEqual(USAGE);
  });

  test('a provider that reports no usage produces metrics WITHOUT a usage key', async () => {
    // Pinned as a key-absence check: `usage: undefined` would survive toEqual
    // but break consumers that iterate metric keys or JSON-roundtrip them.
    const { log, events } = collectEvents();
    const mgr = new SessionManager({ createStt: async () => new FakeStt(), createLlm: () => fakeLlm(), events });
    const id = await mgr.start();
    await mgr.stop(id);
    const m = (log.find((e) => e.type === 'done')!.data as { metrics: AnswerMetrics }).metrics;
    expect('usage' in m).toBe(false);
  });
});

describe('contextual follow-ups', () => {
  test('passes a snapshot of context and per-answer style without leaking into later questions', async () => {
    const { events, log } = collectEvents();
    const requests: Array<ContextSnapshot | undefined> = [];
    const manager = new SessionManager({
      createStt: async () => new FakeStt(),
      createLlm: (snapshot) => ({
        async generate(_question, onDelta) {
          requests.push(snapshot);
          onDelta('An explanation.');
          return 'An explanation.';
        },
      }),
      events,
    });
    const options: AskOptions = { context: [{ question: 'What is a cache?', answer: 'A store for reused results.' }], answerStyle: 'detailed' };
    await manager.ask('Show an example.', options);
    options.context![0]!.answer = 'Changed after asking';
    options.answerStyle = 'brief';
    await until(() => log.some((event) => event.type === 'done'));
    expect(requests[0]).toMatchObject({ conversation: [{ question: 'What is a cache?', answer: 'A store for reused results.' }], output: { answerStyle: 'detailed' } });
    await manager.ask('A separate question');
    await until(() => log.filter((event) => event.type === 'done').length === 2);
    expect(requests[1]).toBeUndefined();
    const id = await manager.start();
    await manager.stop(id);
    expect(requests[2]).toBeUndefined();
  });
});
