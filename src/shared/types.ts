// Types shared between main, preload, and renderer. No runtime code with side
// effects — this module must stay importable from every process.

export type LlmProviderId = 'anthropic' | 'groq';

/** How long an answer should be. Feeds the system prompt; does not change the cached prefix shape. */
export type AnswerStyle = 'brief' | 'balanced' | 'detailed';

/** Default global shortcut that toggles recording while the call app has focus. */
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';

/** Settings as seen by the renderer. API keys never cross the bridge — only presence flags. */
export interface SettingsView {
  resume: string;
  jobDescription: string;
  alwaysOnTop: boolean;
  llmProvider: LlmProviderId;
  answerStyle: AnswerStyle;
  /** Electron accelerator string; empty disables the global shortcut. */
  hotkey: string;
  /** False when the accelerator could not be registered (taken by another app). */
  hotkeyRegistered: boolean;
  hasDeepgramKey: boolean;
  hasAnthropicKey: boolean;
  hasGroqKey: boolean;
}

/** Settings patch sent from the renderer. Key fields are write-only: an empty string clears a key, undefined leaves it untouched. */
export interface SettingsPatch {
  resume?: string;
  jobDescription?: string;
  alwaysOnTop?: boolean;
  llmProvider?: LlmProviderId;
  answerStyle?: AnswerStyle;
  hotkey?: string;
  deepgramKey?: string;
  anthropicKey?: string;
  groqKey?: string;
}

export type ErrorCode =
  | 'no_stt_key'
  | 'no_llm_key'
  | 'stt_connect'
  | 'stt_error'
  | 'stt_timeout'
  | 'no_speech'
  | 'llm_auth'
  | 'llm_http'
  | 'llm_rate_limit'
  | 'llm_first_token_timeout'
  | 'llm_timeout'
  | 'aborted'
  | 'internal';

export interface AppError {
  code: ErrorCode;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

/** Wall-clock latency of one answer, measured in main. Surfaced so regressions are visible in the UI. */
export interface AnswerMetrics {
  /** Stop pressed → final transcript in hand. */
  sttFinalizeMs: number;
  /** Stop pressed → first answer token rendered. The number this app exists to keep small. */
  firstTokenMs: number;
  /** Stop pressed → answer complete. */
  totalMs: number;
}

// Events streamed from main to the renderer. Every event is tagged with the
// session it belongs to; the renderer drops events for stale sessions.
export interface SttPartialEvent {
  sessionId: number;
  text: string;
  isFinal: boolean;
}

export interface LlmDeltaEvent {
  sessionId: number;
  delta: string;
}

export interface LlmDoneEvent {
  sessionId: number;
  transcript: string;
  answer: string;
  metrics: AnswerMetrics;
}

export interface SessionErrorEvent {
  sessionId: number;
  error: AppError;
}

/** The API surface exposed to the renderer via contextBridge. */
export interface RendererApi {
  getSettings(): Promise<SettingsView>;
  saveSettings(patch: SettingsPatch): Promise<SettingsView>;
  startSession(): Promise<Result<number>>;
  sendAudio(sessionId: number, pcm: ArrayBuffer): void;
  stopSession(sessionId: number): Promise<Result<null>>;
  cancelSession(sessionId: number): Promise<void>;
  onSttPartial(cb: (e: SttPartialEvent) => void): () => void;
  onLlmDelta(cb: (e: LlmDeltaEvent) => void): () => void;
  onLlmDone(cb: (e: LlmDoneEvent) => void): () => void;
  onSessionError(cb: (e: SessionErrorEvent) => void): () => void;
  /** Fired when the global hotkey is pressed; the renderer decides record vs. stop. */
  onHotkeyToggle(cb: () => void): () => void;
}
