import { performance } from 'node:perf_hooks';
import type { AnswerMetrics, AppError, ContextSnapshot, LlmProviderId } from '../shared/types';
import { CONTEXT_LIMITS, contextCharacters } from '../shared/context';
import { contextSnapshotSchema } from './context-schema';

// One live question/answer pipeline. The manager owns exactly one active
// session; starting a new one aborts the old, which is what makes
// "record again while an answer is still streaming" safe — stale STT/LLM
// events are dropped by session ID, and the old network work is cancelled.
//
// Dependencies are injected so the manager is unit-testable without Electron
// or the network.

export interface SttStream {
  /** Called with the best current transcript whenever it changes. */
  onPartial(cb: (text: string, isFinal: boolean) => void): void;
  /** Called when the stream dies on its own (socket close, provider error). */
  onError(cb: (error: AppError) => void): void;
  sendAudio(pcm: ArrayBuffer): void;
  /** Flush and return the final transcript. Must settle within timeoutMs. */
  finalize(timeoutMs: number): Promise<string>;
  /** Tear down immediately; no further callbacks may fire. */
  abort(): void;
}

export interface LlmProvider {
  generate(transcript: string, onDelta: (delta: string) => void, signal: AbortSignal): Promise<string>;
}

export interface SessionEvents {
  onSttPartial(sessionId: number, text: string, isFinal: boolean): void;
  onLlmDelta(sessionId: number, delta: string): void;
  onLlmDone(sessionId: number, transcript: string, answer: string, metrics: AnswerMetrics, context?: ContextSnapshot): void;
  onError(sessionId: number, error: AppError): void;
}

export interface SessionDeps {
  createStt(): Promise<SttStream>;
  createLlm(context?: ContextSnapshot, provider?: LlmProviderId): LlmProvider;
  events: SessionEvents;
  timeouts?: Partial<Timeouts>;
}

export interface Timeouts {
  sttFinalizeMs: number;
  llmFirstTokenMs: number;
  llmTotalMs: number;
}

const DEFAULT_TIMEOUTS: Timeouts = {
  sttFinalizeMs: 5_000,
  llmFirstTokenMs: 10_000,
  llmTotalMs: 60_000,
};

export function toAppError(err: unknown, fallbackCode: AppError['code'] = 'internal'): AppError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: unknown; message: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return { code: e.code as AppError['code'], message: e.message };
    }
  }
  return { code: fallbackCode, message: err instanceof Error ? err.message : String(err) };
}

interface ActiveSession {
  id: number;
  context?: ContextSnapshot;
  provider?: LlmProviderId;
  /** Null for ask() sessions: the question arrived as text, nothing to record. */
  stt: SttStream | null;
  abort: AbortController;
  stopped: boolean;
  /** Set once finalize() has handed back a transcript: STT's job is done. */
  transcriptFinal: boolean;
}

export class SessionManager {
  private deps: SessionDeps;
  private timeouts: Timeouts;
  private nextId = 1;
  /** The most recently begun start() or ask(); an older in-flight start is superseded. */
  private latestStartId = 0;
  private active: ActiveSession | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  /** Start a new session, aborting any previous one. Resolves once STT is connected. */
  async start(context?: ContextSnapshot, provider?: LlmProviderId): Promise<number> {
    const snapshot = this.snapshot(context);
    this.cancelActive();
    const id = this.nextId++;
    // Claim "newest start" before the await. createStt() is a network round-trip,
    // so the user can hit record again while we are still connecting; only the
    // newest start may install itself as the active session.
    this.latestStartId = id;
    const abort = new AbortController();
    const stt = await this.deps.createStt();
    if (this.latestStartId !== id) {
      stt.abort();
      throw { code: 'aborted', message: 'superseded by a newer session' } satisfies AppError;
    }
    // Install before wiring: a stream that died while we were connecting
    // delivers its queued error synchronously from onError(), and that error
    // must find a live session to tear down instead of being dropped.
    this.active = { id, stt, abort, stopped: false, transcriptFinal: false, context: snapshot, provider };
    stt.onPartial((text, isFinal) => {
      if (this.active?.id === id) this.deps.events.onSttPartial(id, text, isFinal);
    });
    // A queued connect-time error must reject start itself: the renderer has
    // not received this id yet and cannot reliably adopt a session:error event.
    let wiring = true;
    let connectError: AppError | undefined;
    stt.onError((err) => {
      if (wiring) connectError = toAppError(err, 'stt_error');
      else this.handleSttError(id, err);
    });
    wiring = false;
    if (connectError) {
      this.cancelActive();
      throw connectError;
    }
    return id;
  }

  audio(sessionId: number, pcm: ArrayBuffer): void {
    const s = this.active;
    if (s && s.id === sessionId && !s.stopped) s.stt?.sendAudio(pcm);
  }

  /**
   * Answer a typed (or re-asked) question directly, skipping recording and STT
   * entirely. Supersedes any active session exactly like start(). Resolves with
   * the session id right away — the answer then streams through the same events
   * as a recorded session: one final onSttPartial carrying the question text,
   * onLlmDelta per token, and onLlmDone (or onError). Metrics are measured from
   * this call, with sttFinalizeMs pinned to 0 since nothing was finalized.
   */
  async ask(text: string, context?: ContextSnapshot, provider?: LlmProviderId): Promise<number> {
    // The latency clock starts the moment the user submits the question.
    const t0 = performance.now();
    const trimmed = typeof text === 'string' ? text.trim() : '';
    const snapshot = this.snapshot(context);
    // ipc validates too; stay defensive so no caller can launch an LLM run on
    // an empty prompt. Checked before cancelActive: invalid input must not
    // kill a session that is mid-flight.
    if (!trimmed || trimmed.length > 8_000) {
      throw { code: 'internal', message: 'Question must contain between 1 and 8,000 characters.' } satisfies AppError;
    }
    this.validateRequestSize(trimmed, snapshot);
    this.cancelActive();
    const id = this.nextId++;
    // Claim "newest" exactly like start(): an in-flight start() that resolves
    // later must discover it lost, and a later start()/ask() supersedes us.
    this.latestStartId = id;
    const s: ActiveSession = {
      id,
      context: snapshot,
      provider,
      stt: null, // the question arrived as text — nothing to record or finalize
      abort: new AbortController(),
      stopped: true, // there is no recording to stop; audio() must be a no-op
      transcriptFinal: true,
    };
    this.active = s;
    // Deferred a tick so the caller holds the session id before the first
    // event lands — mirrors start(), where events can only follow resolution.
    setImmediate(() => void this.runAsk(s, trimmed, t0));
    return id;
  }

  private runAsk(s: ActiveSession, transcript: string, t0: number): Promise<void> {
    return this.runGuarded(s.id, async () => {
      if (this.isStale(s.id)) return; // cancelled/replaced before the tick fired
      // sttFinalizeMs pinned to 0: no STT stage ran, reporting anything else
      // would be a lie.
      await this.streamAnswer(s, transcript, t0, 0);
    });
  }

  /**
   * Stop recording: finalize STT, then stream the LLM answer.
   *
   * Returns false when `sessionId` is not the live, not-yet-stopped session —
   * i.e. nothing was started, or it was already torn down by an error the
   * caller never saw. That answer has to reach the caller: every other outcome
   * arrives as an event, so a caller told nothing would wait forever for an
   * event that is never coming.
   */
  async stop(sessionId: number): Promise<boolean> {
    const s = this.active;
    // `!s.stt` is the ask() case: there is no recording to stop. Those sessions
    // are also created with stopped=true, but the extra check keeps the type honest.
    if (!s || s.id !== sessionId || s.stopped || !s.stt) return false;
    s.stopped = true;
    await this.runStop(s, s.stt, sessionId);
    return true;
  }

  private runStop(s: ActiveSession, stt: SttStream, sessionId: number): Promise<void> {
    // The only clock that matters: the user pressed stop and is now waiting.
    const t0 = performance.now();
    return this.runGuarded(sessionId, async () => {
      const transcript = (await stt.finalize(this.timeouts.sttFinalizeMs)).trim();
      const sttFinalizeMs = Math.round(performance.now() - t0);
      if (this.isStale(sessionId)) return;
      s.transcriptFinal = true;
      if (!transcript) {
        throw {
          code: 'no_speech',
          message: 'No speech detected in the recording. Make sure call audio is playing.',
        } satisfies AppError;
      }
      await this.streamAnswer(s, transcript, t0, sttFinalizeMs);
    });
  }

  /**
   * The tail every pipeline shares once it holds a final transcript: echo it as
   * one final partial, stream the answer, report metrics against the caller's
   * clock (t0 = the moment the user acted, so recording time never leaks in).
   */
  private async streamAnswer(
    s: ActiveSession,
    transcript: string,
    t0: number,
    sttFinalizeMs: number,
  ): Promise<void> {
    this.validateRequestSize(transcript, s.context);
    const since = () => Math.round(performance.now() - t0);
    let firstTokenMs: number | null = null;
    // The renderer keys everything off the recorded-session event shape, so
    // the transcript always goes out as one already-final partial.
    this.deps.events.onSttPartial(s.id, transcript, true);
    const llm = this.deps.createLlm(s.context, s.provider);
    const answer = await this.runLlm(s, transcript, llm, () => {
      firstTokenMs = since();
    });
    if (this.isStale(s.id)) return;
    const totalMs = since();
    this.deps.events.onLlmDone(s.id, transcript, answer, {
      sttFinalizeMs,
      // A provider that returns the whole answer without ever streaming a
      // delta had no "first token" moment; reporting 0 would read as instant.
      firstTokenMs: firstTokenMs ?? totalMs,
      totalMs,
    }, s.context);
  }

  private snapshot(context?: ContextSnapshot): ContextSnapshot | undefined {
    if (!context) return undefined;
    // Parsing copies nested objects and validates before the live session is
    // superseded. Freeze to prevent accidental mutation by a provider or caller.
    const snapshot = contextSnapshotSchema.parse(context);
    Object.freeze(snapshot.output);
    if (snapshot.relatedAnswer) Object.freeze(snapshot.relatedAnswer);
    return Object.freeze(snapshot);
  }

  private validateRequestSize(transcript: string, context?: ContextSnapshot): void {
    if (transcript.length > 32_000 || transcript.length + (context ? contextCharacters(context) : 0) > CONTEXT_LIMITS.total) {
      throw { code: 'internal', message: 'This answer request is too large. Shorten the question or background.' } satisfies AppError;
    }
  }

  /**
   * The error/teardown contract every pipeline runs under, in one place so the
   * ask and stop paths cannot drift: an error for a session that was replaced
   * or cancelled is dropped (the user moved on), 'aborted' is silent even for
   * the live session (the user asked for it), anything else reaches the
   * renderer as a structured event — and the slot is released exactly once, but
   * only if this session still owns it.
   */
  private async runGuarded(sessionId: number, pipeline: () => Promise<void>): Promise<void> {
    try {
      await pipeline();
    } catch (err) {
      if (this.isStale(sessionId)) return;
      const appErr = toAppError(err);
      // A finalize/provider/validation failure is terminal too. A provider is
      // not required to close its transport before rejecting; release it here.
      this.cancelActive();
      if (appErr.code !== 'aborted') this.deps.events.onError(sessionId, appErr);
    } finally {
      if (this.active?.id === sessionId) this.active = null;
    }
  }

  cancel(sessionId: number): void {
    if (this.active?.id === sessionId) this.cancelActive();
  }

  providerFor(sessionId: number): LlmProviderId | undefined {
    return this.active?.id === sessionId ? this.active.provider : undefined;
  }

  // The STT stream died by itself (socket close, provider error). While we are
  // still recording or finalizing, that is the user's problem: it would
  // otherwise surface as a silently truncated transcript, or as a confusing
  // "no speech detected". Once the transcript is in hand the STT stream has
  // done its job and a late error must not kill an answer already streaming.
  private handleSttError(sessionId: number, err: unknown): void {
    const s = this.active;
    if (!s || s.id !== sessionId || s.transcriptFinal) return;
    this.active = null;
    s.abort.abort();
    s.stt?.abort();
    this.deps.events.onError(sessionId, toAppError(err, 'stt_error'));
  }

  // Stale = replaced or cancelled (cancelActive nulls `active`). The abort
  // signal alone is NOT staleness: internal timeouts abort the in-flight work
  // but their error must still reach the renderer.
  private isStale(sessionId: number): boolean {
    return this.active?.id !== sessionId;
  }

  private cancelActive(): void {
    const s = this.active;
    if (!s) return;
    this.active = null;
    s.abort.abort();
    s.stt?.abort();
  }

  private async runLlm(
    s: ActiveSession,
    transcript: string,
    llm: LlmProvider,
    onFirstToken: () => void,
  ): Promise<string> {
    const { signal } = s.abort;
    let gotFirstToken = false;

    return await new Promise<string>((resolve, reject) => {
      const firstTokenTimer = setTimeout(() => {
        if (!gotFirstToken) {
          fail({ code: 'llm_first_token_timeout', message: 'The answer model did not start responding in time.' });
        }
      }, this.timeouts.llmFirstTokenMs);
      const totalTimer = setTimeout(() => {
        fail({ code: 'llm_timeout', message: 'The answer took too long and was cancelled.' });
      }, this.timeouts.llmTotalMs);

      let settled = false;
      const cleanup = () => {
        clearTimeout(firstTokenTimer);
        clearTimeout(totalTimer);
        signal.removeEventListener('abort', onAbort);
      };
      const fail = (error: AppError) => {
        if (settled) return;
        settled = true;
        cleanup();
        s.abort.abort();
        reject(error);
      };
      const onAbort = () => fail({ code: 'aborted', message: 'cancelled' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      // Include synchronous provider throws in the same cleanup path as a
      // rejected promise. Neither kind of failure may leave timeout handles.
      Promise.resolve().then(() => settled ? '' : llm.generate(
          transcript,
          (delta) => {
            if (!gotFirstToken) {
              gotFirstToken = true;
              onFirstToken();
            }
            if (!settled && this.active?.id === s.id) this.deps.events.onLlmDelta(s.id, delta);
          },
          signal,
        ))
        .then((full) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(full);
        })
        .catch((err) => {
          if (signal.aborted) fail({ code: 'aborted', message: 'cancelled' });
          else fail(toAppError(err, 'llm_http'));
        });
    });
  }
}
