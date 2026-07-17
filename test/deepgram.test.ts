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

  test('does not report the close it asked for as an error', async () => {
    const { stream, ws } = await connected();
    const errors: AppError[] = [];
    stream.onError((e) => errors.push(e));

    const done = stream.finalize(5_000);
    ws.emitClose(1000, '');
    await done;
    expect(errors).toEqual([]);
  });

  test('settles within the timeout when the server never closes', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    ws.emitMessage(results('half a sentence', true));

    const done = stream.finalize(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(done).resolves.toBe('half a sentence');
    expect(ws.closeCalls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0); // keepalive and finalize timers both cleared
  });

  // Waiting on a socket we already know is dead burned the entire 5 s finalize
  // budget — straight onto stop-to-first-word — to return this same string.
  test('returns at once when the CloseStream send throws', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    ws.emitMessage(results('what we caught', true));
    ws.sendError = new Error('socket already gone');

    // No timer advance at all: finalize must settle on its own.
    await expect(stream.finalize(5_000)).resolves.toBe('what we caught');
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

  test('returns the best transcript available after a mid-stream error', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    stream.onError(() => {});
    ws.emitMessage(results('got this far', true));
    ws.emitSocketError();

    await expect(stream.finalize(5_000)).resolves.toBe('got this far');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('resolves without waiting when the socket already closed', async () => {
    vi.useFakeTimers();
    const { stream, ws } = await connected();
    stream.onError(() => {});
    ws.emitMessage(results('all of it', true));
    ws.emitClose(1000, '');

    await expect(stream.finalize(5_000)).resolves.toBe('all of it');
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
});
