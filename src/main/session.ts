import { performance } from 'node:perf_hooks';
import type { AnswerMetrics, AppError } from '../shared/types';

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
  onLlmDone(sessionId: number, transcript: string, answer: string, metrics: AnswerMetrics): void;
  onError(sessionId: number, error: AppError): void;
}

export interface SessionDeps {
  createStt(): Promise<SttStream>;
  createLlm(): LlmProvider;
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
  async start(): Promise<number> {
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
    this.active = { id, stt, abort, stopped: false, transcriptFinal: false };
    stt.onPartial((text, isFinal) => {
      if (this.active?.id === id) this.deps.events.onSttPartial(id, text, isFinal);
    });
    stt.onError((err) => this.handleSttError(id, err));
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
  async ask(text: string): Promise<number> {
    // The latency clock starts the moment the user submits the question.
    const t0 = performance.now();
    const trimmed = text.trim();
    // ipc validates too; stay defensive so no caller can launch an LLM run on
    // an empty prompt. Checked before cancelActive: invalid input must not
    // kill a session that is mid-flight.
    if (!trimmed) {
      throw { code: 'internal', message: 'Cannot ask an empty question.' } satisfies AppError;
    }
    this.cancelActive();
    const id = this.nextId++;
    // Claim "newest" exactly like start(): an in-flight start() that resolves
    // later must discover it lost, and a later start()/ask() supersedes us.
    this.latestStartId = id;
    const s: ActiveSession = {
      id,
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

  private async runAsk(s: ActiveSession, transcript: string, t0: number): Promise<void> {
    const sessionId = s.id;
    const since = () => Math.round(performance.now() - t0);
    let firstTokenMs: number | null = null;
    try {
      if (this.isStale(sessionId)) return; // cancelled/replaced before the tick fired
      // The renderer keys everything off the recorded-session event shape, so
      // the question goes out as an already-final transcript.
      this.deps.events.onSttPartial(sessionId, transcript, true);
      const llm = this.deps.createLlm();
      const answer = await this.runLlm(s, transcript, llm, () => {
        firstTokenMs = since();
      });
      if (this.isStale(sessionId)) return;
      const totalMs = since();
      this.deps.events.onLlmDone(sessionId, transcript, answer, {
        sttFinalizeMs: 0, // no STT stage: reporting anything else would be a lie
        // Same rule as runStop: a provider that never streamed a delta had no
        // "first token" moment, and 0 would read as instant.
        firstTokenMs: firstTokenMs ?? totalMs,
        totalMs,
      });
    } catch (err) {
      if (this.isStale(sessionId)) return;
      const appErr = toAppError(err);
      if (appErr.code !== 'aborted') this.deps.events.onError(sessionId, appErr);
    } finally {
      if (this.active?.id === sessionId) this.active = null;
    }
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

  private async runStop(s: ActiveSession, stt: SttStream, sessionId: number): Promise<void> {
    // The only clock that matters: the user pressed stop and is now waiting.
    const t0 = performance.now();
    const since = () => Math.round(performance.now() - t0);
    let firstTokenMs: number | null = null;

    try {
      const transcript = (await stt.finalize(this.timeouts.sttFinalizeMs)).trim();
      const sttFinalizeMs = since();
      if (this.isStale(sessionId)) return;
      s.transcriptFinal = true;
      if (!transcript) {
        throw {
          code: 'no_speech',
          message: 'No speech detected in the recording. Make sure call audio is playing.',
        } satisfies AppError;
      }
      this.deps.events.onSttPartial(sessionId, transcript, true);

      const llm = this.deps.createLlm();
      const answer = await this.runLlm(s, transcript, llm, () => {
        firstTokenMs = since();
      });
      if (this.isStale(sessionId)) return;
      const totalMs = since();
      this.deps.events.onLlmDone(sessionId, transcript, answer, {
        sttFinalizeMs,
        // A provider that returns the whole answer without ever streaming a
        // delta had no "first token" moment; reporting 0 would read as instant.
        firstTokenMs: firstTokenMs ?? totalMs,
        totalMs,
      });
    } catch (err) {
      if (this.isStale(sessionId)) return;
      const appErr = toAppError(err);
      if (appErr.code !== 'aborted') this.deps.events.onError(sessionId, appErr);
    } finally {
      if (this.active?.id === sessionId) this.active = null;
    }
  }

  cancel(sessionId: number): void {
    if (this.active?.id === sessionId) this.cancelActive();
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
      };
      const fail = (error: AppError) => {
        if (settled) return;
        settled = true;
        cleanup();
        s.abort.abort();
        reject(error);
      };

      llm
        .generate(
          transcript,
          (delta) => {
            if (!gotFirstToken) {
              gotFirstToken = true;
              onFirstToken();
            }
            if (!settled && this.active?.id === s.id) this.deps.events.onLlmDelta(s.id, delta);
          },
          signal,
        )
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
