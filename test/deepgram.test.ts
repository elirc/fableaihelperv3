import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeepgramStream, parseDeepgramFrame, parseDeepgramMessage } from '../src/main/stt/deepgram';
import type { AppError } from '../src/shared/types';

function results(transcript: string, isFinal: boolean): string {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] },
  });
}

describe('parseDeepgramMessage', () => {
  test('extracts an interim transcript', () => {
    expect(parseDeepgramMessage(results('hello wor', false))).toEqual({
      transcript: 'hello wor',
      isFinal: false,
    });
  });

  test('extracts a final transcript', () => {
    expect(parseDeepgramMessage(results('hello world.', true))).toEqual({
      transcript: 'hello world.',
      isFinal: true,
    });
  });

  test('returns an empty final so callers can clear the interim', () => {
    expect(parseDeepgramMessage(results('', true))).toEqual({ transcript: '', isFinal: true });
  });

  test('ignores Metadata and other non-Results messages', () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Metadata', duration: 3.1 }))).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: 'UtteranceEnd' }))).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: 'SpeechStarted' }))).toBeNull();
  });

  test('ignores malformed JSON and shapes missing the transcript', () => {
    expect(parseDeepgramMessage('{oops')).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Results', channel: {} }))).toBeNull();
  });

  test('never reports an Error frame as a transcript', () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Error', description: 'nope' }))).toBeNull();
  });
});

describe('parseDeepgramFrame', () => {
  test('decodes transcript frames', () => {
    expect(parseDeepgramFrame(results('hello wor', false))).toEqual({
      kind: 'transcript',
      transcript: 'hello wor',
      isFinal: false,
    });
    expect(parseDeepgramFrame(results('hello world.', true))).toEqual({
      kind: 'transcript',
      transcript: 'hello world.',
      isFinal: true,
    });
  });

  // Shape sent by Deepgram's v1 listen socket — the SDKs decode it as
  // ErrorResponse { type, description, message, variant }.
  test('decodes a v1 listen Error frame, quoting description and variant', () => {
    const frame = parseDeepgramFrame(
      JSON.stringify({
        type: 'Error',
        description: 'Deepgram did not receive audio data within the timeout window.',
        message: 'NET-0001',
        variant: 'TIMEOUT',
      }),
    );
    expect(frame?.kind).toBe('error');
    const { error } = frame as { error: AppError };
    expect(error.code).toBe('stt_error');
    expect(error.message).toContain('did not receive audio data');
    expect(error.message).toContain('TIMEOUT');
  });

  // Shape sent by Deepgram's newer Flux/agent sockets: { type, code, description }.
  test('decodes an Error frame that carries code instead of variant', () => {
    const frame = parseDeepgramFrame(
      JSON.stringify({ type: 'Error', code: 'INTERNAL_SERVER_ERROR', description: 'something broke' }),
    );
    const { error } = frame as { error: AppError };
    expect(error.code).toBe('stt_error');
    expect(error.message).toContain('something broke');
    expect(error.message).toContain('INTERNAL_SERVER_ERROR');
  });

  test('falls back to message when description is absent', () => {
    const frame = parseDeepgramFrame(JSON.stringify({ type: 'Error', message: 'DATA-0000' }));
    const { error } = frame as { error: AppError };
    expect(error.message).toContain('DATA-0000');
  });

  test('still reports a bare Error frame carrying no detail', () => {
    expect(parseDeepgramFrame(JSON.stringify({ type: 'Error' }))).toEqual({
      kind: 'error',
      error: { code: 'stt_error', message: 'Deepgram reported a transcription error.' },
    });
  });

  test('returns null for frames we do not act on', () => {
    expect(parseDeepgramFrame(JSON.stringify({ type: 'Metadata', duration: 3.1 }))).toBeNull();
    expect(parseDeepgramFrame(JSON.stringify({ type: 'UtteranceEnd' }))).toBeNull();
    expect(parseDeepgramFrame('{oops')).toBeNull();
  });
});

// The frame parser sits directly on the network: every byte Deepgram (or a
// proxy in between) sends lands here first. These pin that no shape it can
// produce — or that a hostile intermediary could inject — reaches typed code.
describe('parseDeepgramFrame hostile inputs', () => {
  test('an empty alternatives array yields no frame', () => {
    // `alternatives[0]` is undefined; optional chaining must absorb it rather
    // than hand `undefined.transcript` a TypeError inside the message handler.
    expect(parseDeepgramFrame(JSON.stringify({ type: 'Results', channel: { alternatives: [] } }))).toBeNull();
  });

  test('a missing channel or a null channel yields no frame', () => {
    expect(parseDeepgramFrame(JSON.stringify({ type: 'Results' }))).toBeNull();
    expect(parseDeepgramFrame(JSON.stringify({ type: 'Results', channel: null }))).toBeNull();
    expect(parseDeepgramFrame(JSON.stringify({ type: 'Results', channel: 'nope' }))).toBeNull();
  });

  test('a non-string transcript yields no frame', () => {
    // The transcript is pushed into strings the whole pipeline concatenates; a
    // number or object leaking through would corrupt the joined transcript.
    for (const transcript of [42, null, ['a'], { text: 'a' }]) {
      expect(
        parseDeepgramFrame(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript }] } })),
      ).toBeNull();
    }
  });

  test('is_final must be literally true — truthy imposters read as interim', () => {
    // A final wrongly promoted commits revisable text into the committed
    // prefix; treating imposters as interim is the safe direction.
    for (const is_final of ['true', 1, {}, []]) {
      expect(
        parseDeepgramFrame(
          JSON.stringify({ type: 'Results', is_final, channel: { alternatives: [{ transcript: 'hi' }] } }),
        ),
      ).toEqual({ kind: 'transcript', transcript: 'hi', isFinal: false });
    }
  });

  test('scalar and array JSON payloads are ignored without throwing', () => {
    for (const raw of ['null', '42', '"Results"', '[]', 'true']) {
      expect(parseDeepgramFrame(raw)).toBeNull();
    }
  });

  test('a pathologically nested payload cannot crash the message handler', () => {
    // Deep nesting can blow the JSON.parse stack (a catchable RangeError); the
    // parser must swallow it like any other malformed frame. A huge but flat
    // transcript, by contrast, is legitimate and must survive.
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    expect(() => parseDeepgramFrame(deep)).not.toThrow();
    expect(parseDeepgramFrame(deep)).toBeNull();

    const huge = 'word '.repeat(200_000).trim();
    const frame = parseDeepgramFrame(
      JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: huge }] } }),
    );
    expect(frame).toEqual({ kind: 'transcript', transcript: huge, isFinal: true });
  });
});

// ---------------------------------------------------------------------------
// Fake WebSocket. The tests drive open/message/error/close by hand; close()
// deliberately does not fire onclose, because a dead server never answers —
// the tests that want a close emit it themselves.
// ---------------------------------------------------------------------------

interface CloseInit {
  code?: number;
  reason?: string;
}

class FakeWebSocket {
  static last: FakeWebSocket | null = null;

  url: string;
  protocols: string | string[] | undefined;
  binaryType = 'blob';
  sent: unknown[] = [];
  closeCalls = 0;
  /** When set, send() throws it — a socket that died under us. */
  sendError: Error | null = null;

  onopen: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: CloseInit) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
  }

  send(data: unknown): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  emitOpen(): void {
    this.onopen?.();
  }
  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  emitSocketError(): void {
    this.onerror?.({});
  }
  emitClose(code = 1000, reason = ''): void {
    this.onclose?.({ code, reason });
  }

  /** JSON control frames we sent (CloseStream / KeepAlive). */
  controlFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  audioFrames(): ArrayBuffer[] {
    return this.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.last = null;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  vi.useRealTimers();
});

/** Start a connect; the socket exists but has not opened yet. */
function connecting(timeoutMs = 5_000): { promise: Promise<DeepgramStream>; ws: FakeWebSocket } {
  const promise = DeepgramStream.connect('test-key', timeoutMs);
  const ws = FakeWebSocket.last;
  if (!ws) throw new Error('no socket was constructed');
  return { promise, ws };
}

async function connected(): Promise<{ stream: DeepgramStream; ws: FakeWebSocket }> {
  const { promise, ws } = connecting();
  ws.emitOpen();
  return { stream: await promise, ws };
}

function pcm(bytes: number): ArrayBuffer {
  return new ArrayBuffer(bytes);
}

describe('DeepgramStream.connect', () => {
  test('passes the API key as a subprotocol and asks for arraybuffers', async () => {
    const { ws } = await connected();
    expect(ws.protocols).toEqual(['token', 'test-key']);
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.url).toContain('model=nova-3');
  });

  // Regression guard: a failure before open must keep rejecting connect().
  test('rejects with stt_connect when the socket errors before open', async () => {
    const { promise, ws } = connecting();
    ws.emitSocketError();
    await expect(promise).rejects.toMatchObject({ code: 'stt_connect' });
  });

  test('rejects with stt_connect when the connect times out', async () => {
    vi.useFakeTimers();
    const { promise, ws } = connecting(5_000);
    const rejected = expect(promise).rejects.toMatchObject({ code: 'stt_connect' });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(ws.closeCalls).toBeGreaterThan(0);
  });

  // Deepgram refuses a bad key by closing (1008 / DATA-0000) without ever
  // firing onerror. That used to hang connect() for the full 5 s and then blame
  // the network.
  test('rejects at once when Deepgram closes before open, quoting the close reason', async () => {
    vi.useFakeTimers();
    const { promise, ws } = connecting(5_000);
    const rejected = expect(promise).rejects.toMatchObject({
      code: 'stt_connect',
      message: expect.stringContaining('1008: DATA-0000'),
    });
    ws.emitClose(1008, 'DATA-0000');
    await rejected;
    expect(vi.getTimerCount()).toBe(0); // the connect timer is not left running
  });

  // A late onopen must not start a keepalive that nobody will ever clear.
  test('starts no keepalive when the socket opens after the connect timed out', async () => {
    vi.useFakeTimers();
    const { promise, ws } = connecting(5_000);
    const rejected = expect(promise).rejects.toMatchObject({ code: 'stt_connect' });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    ws.sent = [];
    ws.emitOpen();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.controlFrames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DeepgramStream partial transcripts', () => {
  test('reports an interim segment as not final', async () => {
    const { stream, ws } = await connected();
    const seen: Array<[string, boolean]> = [];
    stream.onPartial((t, f) => seen.push([t, f]));

    ws.emitMessage(results('hello wor', false));
    expect(seen).toEqual([['hello wor', false]]);
  });

  // isFinal was hardcoded false, so a segment Deepgram had committed to still
  // claimed to be interim.
  test('reports a finalized segment as final', async () => {
    const { stream, ws } = await connected();
    const seen: Array<[string, boolean]> = [];
    stream.onPartial((t, f) => seen.push([t, f]));

    ws.emitMessage(results('hello world.', true));
    expect(seen).toEqual([['hello world.', true]]);
  });

  test('accumulates finals and appends the live interim, with honest flags', async () => {
    const { stream, ws } = await connected();
    const seen: Array<[string, boolean]> = [];
    stream.onPartial((t, f) => seen.push([t, f]));

    ws.emitMessage(results('what is', false));
    ws.emitMessage(results('What is your', true));
    ws.emitMessage(results('greatest', false));
    ws.emitMessage(results('greatest weakness?', true));

    expect(seen).toEqual([
      ['what is', false],
      ['What is your', true],
      ['What is your greatest', false],
      ['What is your greatest weakness?', true],
    ]);
  });

  test('an empty final clears the interim and is reported as final', async () => {
    const { stream, ws } = await connected();
    const seen: Array<[string, boolean]> = [];
    stream.onPartial((t, f) => seen.push([t, f]));

    ws.emitMessage(results('uhh', false));
    ws.emitMessage(results('', true));
    expect(seen).toEqual([
      ['uhh', false],
      ['', true],
    ]);
  });

  test('a newer interim replaces the previous one instead of appending', async () => {
    const { stream, ws } = await connected();
    const seen: Array<[string, boolean]> = [];
    stream.onPartial((t, f) => seen.push([t, f]));

    ws.emitMessage(results('hel', false));
    ws.emitMessage(results('hello wor', false));

    // 'hel hello wor' here would mean interims were being accumulated like finals.
    expect(seen).toEqual([
      ['hel', false],
      ['hello wor', false],
    ]);
  });

  test('ignores binary frames and frames it does not act on', async () => {
    const { stream, ws } = await connected();
    const seen: string[] = [];
    stream.onPartial((t) => seen.push(t));

    ws.emitMessage(pcm(8));
    ws.emitMessage(JSON.stringify({ type: 'Metadata', duration: 1 }));
    expect(seen).toEqual([]);
  });
});

describe('DeepgramStream.onError', () => {
  // Each of these was silently swallowed before: the user got a truncated
  // transcript (or a confident answer to half a question) and no signal.
  test('surfaces a send failure mid-recording as stt_error', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.sendError = new Error('socket hung up');
    stream.sendAudio(pcm(64));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
    expect(errors[0]?.message).toContain('socket hung up');
  });

  test('surfaces a socket error after open as stt_error', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.emitSocketError();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
  });

  test('surfaces an unexpected mid-recording close as stt_error, quoting the code', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.emitClose(1011, 'NET-0001');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
    expect(errors[0]?.message).toContain('1011: NET-0001');
  });

  test('surfaces a Deepgram Error frame as stt_error', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.emitMessage(JSON.stringify({ type: 'Error', description: 'payment required', variant: 'BILLING' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
    expect(errors[0]?.message).toContain('payment required');
  });

  test('delivers at most one error even when the socket errors, closes, and complains', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.emitSocketError();
    ws.emitClose(1006, '');
    ws.emitMessage(JSON.stringify({ type: 'Error', description: 'and another' }));

    expect(errors).toHaveLength(1);
  });

  test('delivers no error after abort()', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    stream.abort();
    ws.emitSocketError();
    ws.emitClose(1006, '');
    ws.emitMessage(JSON.stringify({ type: 'Error', description: 'too late' }));

    expect(errors).toEqual([]);
  });

  test('fires no partial callbacks after abort()', async () => {
    const { stream, ws } = await connected();
    const seen: string[] = [];
    stream.onPartial((t) => seen.push(t));

    stream.abort();
    ws.emitMessage(results('ignored', true));
    expect(seen).toEqual([]);
  });

  // The session registers onError only after connect() resolves, so an error
  // landing in that window must not be dropped on the floor.
  test('replays an error that arrived before onError was registered', async () => {
    const { stream, ws } = await connected();
    ws.emitSocketError();

    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
  });

  // The queue must drain on first registration: replaying the same failure to
  // every later registration would double-report one dead socket.
  test('delivers a queued error exactly once across onError registrations', async () => {
    const { stream, ws } = await connected();
    ws.emitSocketError();

    const first: AppError[] = [];
    const second: AppError[] = [];
    stream.onError((e) => first.push(e));
    stream.onError((e) => second.push(e));

    expect(first).toHaveLength(1);
    expect(first[0]?.code).toBe('stt_error');
    expect(second).toEqual([]);
  });

  // Once finalize has settled, the stream is over: a socket error trickling in
  // afterwards (TCP reset on the socket we already dropped) is stale news, not
  // a new failure to toast the user with.
  test('ignores a socket error that arrives after the stream is already over', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    const done = stream.finalize(5_000);
    const rejected = expect(done).rejects.toMatchObject({ code: 'stt_timeout' });
    await vi.advanceTimersByTimeAsync(5_000); // server never closed; timeout tore down
    await rejected;

    ws.emitSocketError();
    expect(errors).toEqual([]);
  });

  test('does not replay a queued error to a stream that was aborted first', async () => {
    const { stream, ws } = await connected();
    ws.emitSocketError();
    stream.abort();

    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));
    expect(errors).toEqual([]);
  });

  test('releases the dead socket and stops accepting audio after an error', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.emitSocketError();
    expect(ws.closeCalls).toBeGreaterThan(0);

    ws.sent = [];
    ws.sendError = null;
    stream.sendAudio(pcm(64));
    expect(ws.audioFrames()).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('DeepgramStream audio', () => {
  test('sends audio frames straight through once open', async () => {
    const { stream, ws } = await connected();
    stream.sendAudio(pcm(4));
    stream.sendAudio(pcm(8));
    expect(ws.audioFrames().map((b) => b.byteLength)).toEqual([4, 8]);
  });

  // The pre-open window is not reachable through connect() (it resolves only on
  // open), so this reaches past the public API to pin the memory bound. Without
  // the cap, a 120 s clip against a socket that never opens queues ~3.8 MB of
  // ArrayBuffers that can never be sent.
  test('caps pre-open buffering instead of queueing a whole clip', async () => {
    const { stream } = await connected();
    const internals = stream as unknown as { open: boolean; pending: ArrayBuffer[]; pendingBytes: number };
    internals.open = false; // reproduce the CONNECTING window

    const frame = 4096; // ~128 ms of 16 kHz mono linear16
    for (let i = 0; i < 120 * 8; i++) stream.sendAudio(pcm(frame)); // a 120 s clip

    const queued = internals.pending.reduce((n, b) => n + b.byteLength, 0);
    expect(queued).toBe(internals.pendingBytes); // the byte counter tracks reality
    expect(queued).toBeLessThanOrEqual(160_000); // ~5 s, not 3.8 MB
    expect(internals.pending.length).toBeGreaterThan(0); // still buffering the newest audio
  });

  // Order matters: the buffered audio IS the start of the question. Flushing it
  // out of order would hand Deepgram shuffled speech.
  test('flushes pre-open audio in arrival order once the socket opens', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const internals = stream as unknown as { open: boolean; handleOpen: () => void };
    internals.open = false; // reproduce the CONNECTING window
    stream.sendAudio(pcm(4));
    stream.sendAudio(pcm(8));
    stream.sendAudio(pcm(12));
    expect(ws.audioFrames()).toEqual([]); // nothing hits the wire before open

    internals.handleOpen();
    expect(ws.audioFrames().map((b) => b.byteLength)).toEqual([4, 8, 12]);
    stream.abort();
  });

  test('keeps everything at exactly the 160 KB boundary without dropping', async () => {
    const { stream } = await connected();
    const internals = stream as unknown as { open: boolean; pending: ArrayBuffer[]; pendingBytes: number };
    internals.open = false;

    for (let i = 0; i < 4; i++) stream.sendAudio(pcm(40_000));
    expect(internals.pending.length).toBe(4); // at the cap is fine; over it is not
    expect(internals.pendingBytes).toBe(160_000);
  });

  test('drops the oldest pre-open frame first once over the cap', async () => {
    const { stream } = await connected();
    const internals = stream as unknown as { open: boolean; pending: ArrayBuffer[]; pendingBytes: number };
    internals.open = false;

    stream.sendAudio(pcm(70_000));
    stream.sendAudio(pcm(50_000));
    stream.sendAudio(pcm(40_000)); // exactly 160 000 — still under the drop condition
    stream.sendAudio(pcm(10_000)); // pushes over; the 70 000 frame must go, and only it

    expect(internals.pending.map((b) => b.byteLength)).toEqual([50_000, 40_000, 10_000]);
    expect(internals.pendingBytes).toBe(100_000);
  });

  // The `length > 1` clause in the drop loop: bounded memory must never mean
  // throwing away the only audio we have.
  test('keeps a lone oversized frame rather than dropping the only audio', async () => {
    const { stream } = await connected();
    const internals = stream as unknown as { open: boolean; pending: ArrayBuffer[]; pendingBytes: number };
    internals.open = false;

    stream.sendAudio(pcm(200_000));
    expect(internals.pending.map((b) => b.byteLength)).toEqual([200_000]);
    expect(internals.pendingBytes).toBe(200_000);
  });

  test('drops buffered audio when the stream is torn down', async () => {
    const { stream } = await connected();
    const internals = stream as unknown as { open: boolean; pending: ArrayBuffer[]; pendingBytes: number };
    internals.open = false;
    stream.sendAudio(pcm(4096));
    expect(internals.pending.length).toBe(1);

    stream.abort();
    expect(internals.pending).toEqual([]);
    expect(internals.pendingBytes).toBe(0);
  });
});

describe('DeepgramStream.finalize', () => {
  test('an abnormal close rejects with server details and no duplicate callback', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    const partials: string[] = [];
    stream.onError((error) => errors.push(error));
    stream.onPartial((value) => partials.push(value));
    ws.emitMessage(results('received so far', true));
    const done = stream.finalize(5_000);
    ws.emitClose(1011, 'NET-0001');
    await expect(done).rejects.toMatchObject({ code: 'stt_error', message: expect.stringContaining('NET-0001') });
    ws.emitSocketError();
    ws.emitMessage(results('late text', true));
    expect(errors).toEqual([]);
    expect(partials).toEqual(['received so far']);
  });

  test('finalize consumes a queued error without replaying it to a later callback', async () => {
    const { stream, ws } = await connected();
    ws.emitSocketError();
    await expect(stream.finalize(5_000)).rejects.toMatchObject({ code: 'stt_error' });
    const errors: AppError[] = [];
    stream.onError((error) => errors.push(error));
    expect(errors).toEqual([]);
  });

  test('a provider error during finalize rejects once and ignores post-abort events', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((error) => errors.push(error));
    const done = stream.finalize(5_000);
    ws.emitMessage(JSON.stringify({ type: 'Error', description: 'flush failed' }));
    await expect(done).rejects.toMatchObject({ code: 'stt_error', message: expect.stringContaining('flush failed') });
    stream.abort();
    ws.emitSocketError();
    ws.emitClose(1011, 'late close');
    expect(errors).toEqual([]);
  });

  test('sends CloseStream and resolves with the full transcript once the server closes', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('What is your greatest weakness?', true));

    const done = stream.finalize(5_000);
    expect(ws.controlFrames()).toContainEqual({ type: 'CloseStream' });
    ws.emitClose(1000, '');

    await expect(done).resolves.toBe('What is your greatest weakness?');
  });

  test('includes a trailing interim segment that never got finalized', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('What is your', true));
    ws.emitMessage(results('greatest weakness', false));

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('What is your greatest weakness');
  });

  // The whole point of CloseStream: Deepgram flushes what it is still holding
  // before closing. Those tail frames arrive while we wait and must count.
  test('counts a tail Results frame that lands between CloseStream and the close', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('What is your', true));

    const done = stream.finalize(5_000);
    ws.emitMessage(results('greatest weakness?', true)); // the flush CloseStream asked for
    ws.emitClose(1000, '');

    await expect(done).resolves.toBe('What is your greatest weakness?');
  });

  // Once CloseStream is out the socket is CLOSING: a straggler capture frame
  // can no longer influence the transcript, and a send failure on it must not
  // report a bogus mid-recording error for a stop that is succeeding.
  test('drops audio sent after finalize has asked for the close', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));
    ws.emitMessage(results('done talking', true));

    const done = stream.finalize(5_000);
    ws.sent = [];
    ws.sendError = new Error('socket is CLOSING');
    stream.sendAudio(pcm(64)); // a straggler frame from the capture pipeline

    expect(ws.audioFrames()).toEqual([]);
    expect(errors).toEqual([]);

    ws.sendError = null;
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('done talking');
  });

  // abort() during the close wait must release finalize immediately — a new
  // recording is starting and nobody will ever emit the close it waits for.
  test('abort() during the close wait settles finalize at once with what was heard', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));
    ws.emitMessage(results('so far', true));

    const done = stream.finalize(5_000);
    stream.abort();

    await expect(done).resolves.toBe('so far'); // no timer advance: it must settle on its own
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Waiting on a socket that is not open would burn the entire timeout budget
  // (straight onto stop-to-first-word) before returning this same string.
  test('rejects at once when the socket is not open, without burning the timeout', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    ws.emitMessage(results('caught before the drop', true));
    (stream as unknown as { open: boolean }).open = false; // the socket regressed under us

    await expect(stream.finalize(5_000)).rejects.toMatchObject({ code: 'stt_error' });
    expect(ws.closeCalls).toBeGreaterThan(0); // the dead socket is released
    expect(vi.getTimerCount()).toBe(0);
  });

  // After the timeout teardown, finalize() has already resolved: a late frame
  // firing partials would show the user a transcript that contradicts the
  // answer being generated from the returned one.
  test('ignores frames that arrive after the finalize timeout tore the stream down', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const seen: string[] = [];
    stream.onPartial((t) => seen.push(t));
    ws.emitMessage(results('heard', true));

    const done = stream.finalize(5_000);
    const rejected = expect(done).rejects.toMatchObject({ code: 'stt_timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(seen).toEqual(['heard']);

    seen.length = 0;
    ws.emitMessage(results('heard plus a late tail', true));
    expect(seen).toEqual([]);
    await expect(stream.finalize(5_000)).rejects.toMatchObject({ code: 'stt_timeout' });
  });

  test('an empty final leaves no gap in the joined transcript', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('first part', true));
    ws.emitMessage(results('', true)); // Deepgram finalizing a silent stretch
    ws.emitMessage(results('second part', true));

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('first part second part');
  });

  test('a whitespace-only trailing interim resolves to a trimmed transcript', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('question here', true));
    ws.emitMessage(results('   ', false));

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('question here');
  });

  test('does not report the close it asked for as an error', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await done;
    expect(errors).toEqual([]);
  });

  test('rejects with stt_timeout when the server never closes', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    ws.emitMessage(results('half a sentence', true));

    const done = stream.finalize(5_000);
    const rejected = expect(done).rejects.toMatchObject({ code: 'stt_timeout' });
    await vi.advanceTimersByTimeAsync(5_000);

    await rejected;
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0); // keepalive and finalize timers both cleared
  });

  // Waiting on a socket we already know is dead burned the entire 5 s finalize
  // budget — straight onto stop-to-first-word — to return this same string.
  test('rejects at once with the cause when the CloseStream send throws', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    ws.emitMessage(results('what we caught', true));
    ws.sendError = new Error('socket already gone');

    // No timer advance at all: finalize must settle on its own.
    await expect(stream.finalize(5_000)).rejects.toMatchObject({
      code: 'stt_error', message: expect.stringContaining('socket already gone'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('returns at once after abort(), without sending CloseStream', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    ws.emitMessage(results('partial', true));
    stream.abort();
    ws.sent = [];

    await expect(stream.finalize(5_000)).resolves.toBe('partial');
    expect(ws.controlFrames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rejects after a mid-stream error rather than treating a partial transcript as complete', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    stream.onError(() => {});
    ws.emitMessage(results('got this far', true));
    ws.emitSocketError();

    await expect(stream.finalize(5_000)).rejects.toMatchObject({ code: 'stt_error' });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rejects without waiting when the socket closed before finalize requested it', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    stream.onError(() => {});
    ws.emitMessage(results('all of it', true));
    ws.emitClose(1000, '');

    await expect(stream.finalize(5_000)).rejects.toMatchObject({ code: 'stt_error' });
    expect(vi.getTimerCount()).toBe(0);
  });

  test('is idempotent: a second call joins the first and sends one CloseStream', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('once only', true));

    const first = stream.finalize(5_000);
    const second = stream.finalize(5_000);
    expect(second).toBe(first);
    ws.emitClose(1000, '');

    expect(await first).toBe('once only');
    expect(await second).toBe('once only');
    expect(ws.controlFrames().filter((f) => f['type'] === 'CloseStream')).toHaveLength(1);
  });

  test('returns an empty transcript rather than hanging when nothing was heard', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('');
  });
});

describe('DeepgramStream keepalive', () => {
  test('pings Deepgram while the socket is idle', async () => {
    vi.useFakeTimers();
    const { ws } = await connected();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ws.controlFrames()).toContainEqual({ type: 'KeepAlive' });
  });

  test('stops after abort() and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    stream.abort();
    ws.sent = [];

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.controlFrames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stops when the socket closes unexpectedly', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    stream.onError(() => {});
    ws.emitClose(1006, '');
    ws.sent = [];

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.controlFrames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A KeepAlive after CloseStream is at best ignored by Deepgram; at worst the
  // socket is already CLOSING and the send blows up mid-flush (next test).
  test('sends no KeepAlive once finalize has asked for the close', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();

    const done = stream.finalize(20_000); // wait window longer than the keepalive interval
    ws.sent = [];
    await vi.advanceTimersByTimeAsync(8_000); // one full keepalive tick into the wait

    expect(ws.controlFrames()).toEqual([]);
    ws.emitClose(1000, '');
    await done;
  });

  // The user pressed Stop and the flush is in progress: a keepalive tick
  // discovering the dying socket must not toast a "lost connection" error for
  // a stop that is actually succeeding — finalize returns what was heard.
  test('a close wait timeout rejects once without a duplicate callback or keepalive error', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));
    ws.emitMessage(results('kept', true));

    const done = stream.finalize(20_000);
    const rejected = expect(done).rejects.toMatchObject({ code: 'stt_timeout' });
    ws.sendError = new Error('socket is CLOSING');
    await vi.advanceTimersByTimeAsync(20_000); // crosses the 8 s keepalive tick, then times out

    await rejected;
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a keepalive send failure surfaces as stt_error and stops the interval', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.sendError = new Error('broken pipe');
    await vi.advanceTimersByTimeAsync(8_000);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a mid-recording send failure stops the keepalive — one error total, no timer left', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    ws.sendError = new Error('socket hung up');
    stream.sendAudio(pcm(64));
    expect(errors).toHaveLength(1);

    // The keepalive was live when the audio send died; its next ticks against
    // the same dead socket must not re-report the death every 8 seconds.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a pre-open flush that dies reports once and never starts the keepalive', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));
    const internals = stream as unknown as { open: boolean; handleOpen: () => void };
    internals.open = false; // reproduce the CONNECTING window
    stream.sendAudio(pcm(4));
    stream.sendAudio(pcm(8));
    stream.sendAudio(pcm(12));

    ws.sent = [];
    ws.sendError = new Error('dead before the flush');
    internals.handleOpen();

    // One failure, the rest of the queue abandoned (the stream is already
    // torn down), and no keepalive interval left running on the corpse.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('stt_error');
    expect(ws.audioFrames()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// fullTranscript() runs on every message and now reports from a pre-joined
// committed prefix instead of re-joining every final segment per interim.
// These pin that the cache can never drift from what a full re-join would say.
describe('DeepgramStream committed-transcript caching', () => {
  test('hundreds of interim revisions all report against the same committed prefix', async () => {
    const { stream, ws } = await connected();
    const seen: string[] = [];
    stream.onPartial((t) => seen.push(t));

    ws.emitMessage(results('what is your', true));
    // A long answer generates hundreds of interim revisions; each must combine
    // the committed prefix with ONLY the newest interim, never a stale one.
    for (let i = 0; i < 300; i++) ws.emitMessage(results(`greatest v${i}`, false));
    expect(seen.at(-1)).toBe('what is your greatest v299');

    ws.emitMessage(results('greatest weakness?', true));
    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('what is your greatest weakness?');
  });

  test('finals interleaved with interims extend the prefix in order', async () => {
    const { stream, ws } = await connected();
    const seen: string[] = [];
    stream.onPartial((t) => seen.push(t));

    ws.emitMessage(results('alpha', true));
    ws.emitMessage(results('bet', false));
    ws.emitMessage(results('beta', true)); // the final replaces the interim, not appends after it
    ws.emitMessage(results('gam', false));

    // Any cache-invalidation bug shows up as a duplicated or missing segment
    // in one of these four snapshots.
    expect(seen).toEqual(['alpha', 'alpha bet', 'alpha beta', 'alpha beta gam']);

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await expect(done).resolves.toBe('alpha beta gam');
  });

  test('a whitespace-only final joins byte-identically to the old array join', async () => {
    const { stream, ws } = await connected();
    ws.emitMessage(results('first', true));
    ws.emitMessage(results('   ', true)); // truthy, so it joins — only the string edges are trimmed
    ws.emitMessage(results('second', true));

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    // 'first' + ' ' + '   ' + ' ' + 'second': interior whitespace is preserved
    // exactly as [...finals].join(' ') produced it — the cache must not
    // normalize what the old code passed through.
    await expect(done).resolves.toBe('first' + ' '.repeat(5) + 'second');
  });
});
