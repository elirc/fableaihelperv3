// Types shared between main, preload, and renderer. No runtime code with side
// effects — this module must stay importable from every process.

export type LlmProviderId = 'anthropic' | 'groq';

/** How long an answer should be. Feeds the system prompt; does not change the cached prefix shape. */
export type AnswerStyle = 'brief' | 'balanced' | 'detailed';

export type Situation = 'interview' | 'technical' | 'client' | 'meeting' | 'custom';

export interface OutputPreferences {
  answerStyle: AnswerStyle;
  format: 'spoken' | 'talking-points' | 'star';
  tone: 'conversational' | 'confident' | 'diplomatic';
  audience: 'general' | 'technical' | 'nontechnical';
}

export interface ScenarioProfile {
  id: string;
  name: string;
  situation: Situation;
  background: string;
  instructions: string;
  includeResume: boolean;
  includeJobDescription: boolean;
  output: Partial<OutputPreferences>;
}

/** An explicitly selected, generated suggestion, not a record of what the user said. */
export interface RelatedAnswer {
  question: string;
  answer: string;
}

/** Resolved at submission; no credentials and no mutable references to settings. */
export interface ContextSnapshot {
  profileId: string;
  profileName: string;
  situation: Situation;
  background: string;
  instructions: string;
  resume: string;
  jobDescription: string;
  output: OutputPreferences;
  questionNote: string;
  relatedAnswer?: RelatedAnswer;
  refinement?: string;
}

export interface AnswerOptions {
  profileId?: string;
  overrides?: Partial<OutputPreferences>;
  questionNote?: string;
  snapshot?: ContextSnapshot;
  followUp?: RelatedAnswer;
  refinement?: string;
}

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
  /** Optional at the bridge for compatibility; upgraded stores populate these fields. */
  contextProfiles?: ScenarioProfile[];
  activeProfileId?: string;
  outputDefaults?: OutputPreferences;
  keyStorage?: 'encrypted' | 'plaintext' | 'mixed' | 'none';
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
  contextProfiles?: ScenarioProfile[];
  activeProfileId?: string;
  outputDefaults?: OutputPreferences;
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
  /** Stop pressed → first answer token received in main; excludes IPC and rendering. */
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
  context?: ContextSnapshot;
}

export interface SessionErrorEvent {
  sessionId: number;
  error: AppError;
}

/** The API surface exposed to the renderer via contextBridge. */
export interface RendererApi {
  getSettings(): Promise<SettingsView>;
  saveSettings(patch: SettingsPatch): Promise<SettingsView>;
  startSession(options?: AnswerOptions): Promise<Result<number>>;
  /**
   * Ask a question directly (typed, or a re-ask of an earlier transcript)
   * without recording. Returns a session id; the answer then arrives through
   * the same event stream as a recorded session: one final stt:partial
   * carrying the question text, llm:delta per token, llm:done / session:error.
   */
  askQuestion(text: string, options?: AnswerOptions): Promise<Result<number>>;
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
