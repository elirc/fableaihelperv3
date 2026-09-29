import type { AppError } from '../../shared/types';
import type { SttStream } from '../session';

// Streaming STT over Deepgram's WebSocket API. PCM frames are sent while the
// user is still speaking, so by the time they hit Stop the transcript is
// nearly complete — finalize only has to flush the tail.
//
// Uses the native WebSocket client (Node 22+, present in Electron's main
// process). Deepgram accepts the API key via the Sec-WebSocket-Protocol
// header (`['token', key]`), which is the only auth the browser-style
// WebSocket API can carry.

// Latency note: `endpointing` and `no_delay` are deliberately absent. The
// stop-to-first-word path never waits on Deepgram's endpointer — Stop sends
// CloseStream, which makes the server flush whatever it is still holding
// (including smart_format's entity hold-back) and close. Tuning endpointing
// would only shift when interims get promoted to finals mid-speech, and
// no_delay trades smart_format quality for a wait this client never does.
const DEEPGRAM_URL =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-3&encoding=linear16&sample_rate=16000&channels=1' +
  '&interim_results=true&smart_format=true';

const KEEPALIVE_MS = 8_000;

// Defence, not the mechanism. Audio sent before the socket opens is buffered,
// but in practice nothing reaches that path: connect() resolves on open and the
// session only sends afterwards, so sendAudio always finds an open socket. The
// pre-open buffering that actually covers the capture-vs-connect race lives in
// the renderer (app.ts holds frames until session:start resolves, then flushes).
// The cap matters only if a future caller does send early: linear16 @ 16 kHz
// mono is 32 kB/s, so this is ~5 s of audio, where a 120 s clip against a dead
// socket would otherwise queue ~3.8 MB that can never be sent.
const MAX_PENDING_BYTES = 160_000;

export interface DeepgramMessage {
  transcript: string;
  isFinal: boolean;
}

/** One decoded frame from Deepgram: a transcript update, or a reported failure. */
export type DeepgramFrame =
  | ({ kind: 'transcript' } & DeepgramMessage)
  | { kind: 'error'; error: AppError };

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Deepgram's v1 listen socket reports application-level failures as
// `{"type":"Error","description":...,"message":...,"variant":...}` (the shape
// the official SDKs decode as ErrorResponse). The newer Flux/agent sockets use
// `{"type":"Error","code":...,"description":...}`. Accept either, since the
// field set differs and only some of them are ever populated.
function errorFrame(msg: Record<string, unknown>): DeepgramFrame {
  const detail = text(msg['description']) || text(msg['message']);
  const tag = text(msg['code']) || text(msg['variant']);
  const summary = [detail, tag && `(${tag})`].filter(Boolean).join(' ');
  return {
    kind: 'error',
    error: {
      code: 'stt_error',
      message: summary
        ? `Deepgram reported a transcription error: ${summary}`
        : 'Deepgram reported a transcription error.',
    },
  };
}

/** Decode one Deepgram WS frame; null for frames we don't act on (Metadata, UtteranceEnd, ...). Pure, unit-tested. */
export function parseDeepgramFrame(raw: string): DeepgramFrame | null {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (msg?.type === 'Error') return errorFrame(msg);
  if (msg?.type !== 'Results') return null;
  const transcript = msg.channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== 'string') return null;
  return { kind: 'transcript', transcript, isFinal: msg.is_final === true };
}

/** Extract the transcript from one Deepgram WS message; null for anything that isn't a transcript. */
export function parseDeepgramMessage(raw: string): DeepgramMessage | null {
  const frame = parseDeepgramFrame(raw);
  return frame?.kind === 'transcript' ? { transcript: frame.transcript, isFinal: frame.isFinal } : null;
}

// Deepgram refuses a request by closing the socket rather than by sending a
// frame: 1008 carries a `DATA-xxxx` reason (bad request / bad key), 1011 a
// `NET-xxxx` server fault. Surface whichever detail we got.
function closeDetail(ev?: { code?: number; reason?: string }): string {
  const code = typeof ev?.code === 'number' && ev.code ? String(ev.code) : '';
  return [code, text(ev?.reason)].filter(Boolean).join(': ');
}

export class DeepgramStream implements SttStream {
  private ws: WebSocket;
  /**
   * Every finalized segment, pre-joined with single spaces. Kept as one string
   * rather than an array because fullTranscript() runs on EVERY message —
   * interims arrive several times a second — and re-joining all segments each
   * time is O(recording length) per message, O(n²) over a long recording.
   * Appending here on each final keeps the per-message work O(interim).
   */
  private committed = '';
  private interim = '';
  private partialCb: ((text: string, isFinal: boolean) => void) | null = null;
  private errorCb: ((error: AppError) => void) | null = null;
  /** An error raised before the session registered onError; delivered on registration. */
  private queuedError: AppError | null = null;
  private errorSent = false;
  private terminalError: AppError | null = null;
  private finalizationStarted = false;
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private open = false;
  private everOpen = false;
  private closed = false;
  private aborted = false;
  /** True once we asked to close; only a normal server close is expected during finalize. */
  private closeRequested = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private closeWaiters: (() => void)[] = [];
  private finalizing: Promise<string> | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** Connect and resolve once the socket is open (ready before the first speech frame). */
  static connect(apiKey: string, timeoutMs = 5_000): Promise<DeepgramStream> {
    if (typeof WebSocket === 'undefined') {
      return Promise.reject({
        code: 'stt_connect',
        message: 'WebSocket is not available in this Electron version.',
      } satisfies AppError);
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(DEEPGRAM_URL, ['token', apiKey]);
      ws.binaryType = 'arraybuffer';
      const stream = new DeepgramStream(ws);

      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Mark the stream dead before closing: if onopen still races in, it
        // must not start a keepalive nobody will ever clear.
        stream.closeRequested = true;
        stream.teardown();
        stream.closeSocket();
        reject({ code: 'stt_connect', message } satisfies AppError);
      };

      const timer = setTimeout(() => fail('Timed out connecting to Deepgram.'), timeoutMs);

      ws.onopen = () => {
        if (settled) {
          stream.closeSocket();
          return;
        }
        settled = true;
        clearTimeout(timer);
        stream.handleOpen();
        resolve(stream);
      };
      ws.onerror = () => {
        if (!settled) fail('Could not connect to Deepgram. Check the API key and your network.');
        else stream.handleSocketError();
      };
      ws.onmessage = (ev) => stream.handleMessage(ev);
      ws.onclose = (ev) => {
        // Deepgram rejects a bad key or a bad request by closing, often without
        // ever firing onerror — so a close before open is a connect failure.
        // Without this, connect() hangs until the timeout and blames the network.
        if (!settled) {
          const detail = closeDetail(ev);
          fail(
            `Deepgram closed the connection${detail ? ` (${detail})` : ''}.` +
              ' Check the API key and your network.',
          );
        }
        stream.handleClose(ev);
      };
    });
  }

  onPartial(cb: (text: string, isFinal: boolean) => void): void {
    this.partialCb = cb;
  }

  onError(cb: (error: AppError) => void): void {
    this.errorCb = cb;
    const queued = this.queuedError;
    if (queued && !this.aborted) {
      this.queuedError = null;
      cb(queued);
    }
  }

  sendAudio(pcm: ArrayBuffer): void {
    // closeRequested covers the finalize window: once CloseStream is out the
    // socket is CLOSING, so a straggler capture frame can no longer influence
    // the transcript — and a send failure on it would report a bogus
    // mid-recording error for a stop that is actually succeeding.
    if (this.closed || this.closeRequested) return;
    if (!this.open) {
      this.buffer(pcm);
      return;
    }
    try {
      this.ws.send(pcm);
    } catch (err) {
      // The socket died mid-recording. Staying quiet here is what used to hand
      // the user a silently truncated transcript.
      this.emitError(`Lost the connection to Deepgram while streaming audio${reason(err)}`);
    }
  }

  /** Flush the tail of the transcript and return everything heard. Always settles within timeoutMs. */
  finalize(timeoutMs: number): Promise<string> {
    // Idempotent: a second call must not send another CloseStream or start a
    // second wait — it joins the first and gets the same transcript.
    this.finalizing ??= this.runFinalize(timeoutMs);
    return this.finalizing;
  }

  abort(): void {
    this.aborted = true;
    this.closeRequested = true;
    this.partialCb = null;
    this.errorCb = null;
    this.queuedError = null;
    this.teardown();
    this.closeSocket();
  }

  private async runFinalize(timeoutMs: number): Promise<string> {
    this.finalizationStarted = true;
    // finalize owns error delivery once called; do not replay a queued error
    // through onError as well as rejecting this promise.
    this.queuedError = null;
    if (this.terminalError) throw this.terminalError;
    if (this.closed) return this.fullTranscript();
    this.closeRequested = true;
    // Stop pinging the moment we ask for the close: a KeepAlive after
    // CloseStream is at best ignored, and if the flush wait crosses the next
    // 8 s tick on a socket that is already CLOSING, the failed send would
    // surface a spurious "lost connection" error mid-stop.
    this.stopKeepalive();

    // A missing connection cannot confirm the transcript tail. Fail promptly
    // rather than waiting out the budget or claiming the partial is complete.
    if (!this.open) {
      this.emitError('The connection to Deepgram was lost before the final transcript could be received.');
      throw this.terminalError;
    }
    try {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    } catch (err) {
      this.emitError(`Could not request the final transcript from Deepgram${reason(err)}`);
      throw this.terminalError;
    }
    await this.waitForClose(timeoutMs);
    if (this.terminalError) throw this.terminalError;
    return this.fullTranscript();
  }

  private handleOpen(): void {
    this.open = true;
    this.everOpen = true;
    const queued = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const buf of queued) {
      if (this.closed) return; // a failed flush tore the stream down
      this.sendAudio(buf);
    }
    if (this.closed) return; // ...and must not leave a keepalive running
    this.keepalive = setInterval(() => {
      try {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch (err) {
        this.emitError(`Lost the connection to Deepgram${reason(err)}`);
      }
    }, KEEPALIVE_MS);
  }

  private handleMessage(ev: MessageEvent): void {
    // After teardown the transcript is spoken for — finalize() has already
    // resolved with it (or the stream died and reported why). A late frame
    // must not fire partials or grow the committed text past what was
    // returned, or the on-screen transcript would contradict the answer
    // generated from it. Note this is `closed`, not `closeRequested`: the tail
    // flush between CloseStream and the server close must still count.
    if (this.closed) return;
    if (typeof ev.data !== 'string') return;
    const frame = parseDeepgramFrame(ev.data);
    if (!frame) return;
    if (frame.kind === 'error') {
      this.emitError(frame.error.message);
      return;
    }
    if (frame.isFinal) {
      if (frame.transcript) {
        this.committed = this.committed ? this.committed + ' ' + frame.transcript : frame.transcript;
      }
      this.interim = '';
    } else {
      this.interim = frame.transcript;
    }
    // isFinal marks a segment Deepgram has committed to: the text up to here is
    // stable and won't be revised. Reporting it as always-false made the flag a lie.
    this.partialCb?.(this.fullTranscript(), frame.isFinal);
  }

  private handleSocketError(): void {
    // A socket error after teardown is stale news — we already dropped the
    // socket (finalize settled, abort, or a reported failure), so a TCP reset
    // trickling in afterwards is not a new mid-recording failure.
    if (this.closed) return;
    this.emitError('The connection to Deepgram failed mid-recording.');
  }

  private handleClose(ev?: { code?: number; reason?: string }): void {
    // A close we didn't ask for means the transcript is truncated — say so
    // instead of quietly handing back whatever we happened to catch.
    if (this.closed) return;
    const unexpected = this.everOpen && (!this.closeRequested || ev?.code !== 1000);
    const detail = closeDetail(ev);
    if (unexpected) {
      const stage = this.finalizationStarted ? 'before the final transcript was received' : 'mid-recording';
      this.emitError(`Deepgram closed the connection ${stage}${detail ? ` (${detail})` : ''}.`);
    } else this.teardown();
  }

  private emitError(message: string, code: AppError['code'] = 'stt_error'): void {
    // At most one error per stream, and never after abort().
    if (this.aborted || this.errorSent) return;
    this.errorSent = true;
    const error: AppError = { code, message };
    this.terminalError = error;
    this.closeRequested = true;
    this.teardown();
    this.closeSocket();
    // The waiting finalize promise reports its own failure. Sending onError
    // too would give callers two terminal notifications for one failure.
    if (this.finalizationStarted) return;
    const cb = this.errorCb;
    // The session registers onError only after connect() resolves, so a failure
    // during the pre-open flush would otherwise be dropped on the floor.
    if (cb) cb(error);
    else this.queuedError = error;
  }

  private buffer(pcm: ArrayBuffer): void {
    this.pending.push(pcm);
    this.pendingBytes += pcm.byteLength;
    // Drop the oldest frames once over the cap: if we're this far behind, the
    // transcript is already compromised and bounded memory matters more.
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      const dropped = this.pending.shift();
      if (!dropped) break;
      this.pendingBytes -= dropped.byteLength;
    }
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  private teardown(): void {
    this.closed = true;
    this.open = false;
    this.stopKeepalive();
    this.pending = [];
    this.pendingBytes = 0;
    // The stream is over; nothing else will ever arrive, so release finalize()
    // rather than let it sit until its own timeout.
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of waiters) w();
  }

  private closeSocket(): void {
    try {
      this.ws.close();
    } catch {}
  }

  private waitForClose(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.emitError(
          'Deepgram did not finish transcribing in time. The transcript received so far is still available; review it before retrying.',
          'stt_timeout',
        );
        finish();
      }, timeoutMs);
      this.closeWaiters.push(finish);
    });
  }

  private fullTranscript(): string {
    // The trim stays per-call (not baked into `committed`) so a whitespace-only
    // interim or edge segment renders exactly as the old join-then-trim did.
    const joined = this.interim
      ? this.committed
        ? this.committed + ' ' + this.interim
        : this.interim
      : this.committed;
    return joined.trim();
  }
}

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg ? `: ${msg}` : '.';
}
