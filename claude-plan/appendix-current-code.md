# Appendix — current code (verbatim excerpts)

These are copied from the working tree at review time (2026-09-29), not
paraphrased, so you can review the plan without opening the repository.
Line numbers refer to the working-tree files. The plan changes most of what
is shown here.

## `src/main/prompt.ts` lines 1–83

The whole prompt module. Phase 1 rewrites it.

```ts
import type { AnswerStyle } from '../shared/types';

// Builds the system prompt for the answer model from the user's saved profile.
// Pure functions (no store/electron dependency) so they can be unit-tested directly.
//
// The prompt is deliberately built as TWO pieces:
//
//   cachedPrefix — role instructions + resume + JD. Stable for the whole
//                  interview, and the only piece worth marking with
//                  cache_control (see llm/anthropic.ts).
//   styleSuffix  — the answer-length policy. Changes whenever the user flips
//                  the answerStyle setting.
//
// Prompt caching is a *prefix match*: any byte change invalidates everything
// after it. Folding the style policy into the cached block would mean toggling
// brief/balanced/detailed silently throws away the cached resume+JD and pays a
// full uncached prefill on the next answer — i.e. a slower first token, which
// is the one thing this app exists to avoid. Keeping it in its own trailing
// block means a style change costs nothing.

const ROLE_INSTRUCTIONS =
  'You are a real-time call assistant helping the user answer questions asked of them ' +
  'during a live interview or call. You are given a transcript of what the other person just said. ' +
  'Reply with the answer the user should say, written in first person, in natural spoken English. ' +
  'Do not add meta commentary, greetings, or quotation marks — output only the answer itself. ' +
  'If the transcript contains no real question, briefly suggest what the user could say next.';

// The length/shape policy per style. `balanced` keeps v1's wording verbatim, so
// the default behaviour is unchanged by the introduction of answerStyle.
const STYLE_INSTRUCTIONS: Record<AnswerStyle, string> = {
  brief:
    'Answer in one or two spoken sentences — the shortest reply that fully answers the question. ' +
    'No lists, no headings, no lead-in.',
  balanced:
    'Be concise and confident: a few sentences for simple questions, short structured points for ' +
    'complex ones.',
  detailed:
    'Give a structured answer: one sentence that answers directly, then three to five short ' +
    'supporting points (what the situation was, what you did, what the result was). Keep every ' +
    'point short enough to say in one breath — this is spoken aloud, not read.',
};

export interface SystemPromptBlocks {
  /** Stable for the session. Safe to mark with cache_control. */
  cachedPrefix: string;
  /** Varies with the answerStyle setting. Must sit AFTER the cache breakpoint. */
  styleSuffix: string;
}

/** The system prompt split at the cache breakpoint. Providers that support prompt caching should use this. */
export function buildSystemPromptBlocks(
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
): SystemPromptBlocks {
  const resumeText = (resume || '').trim();
  const jdText = (jd || '').trim();

  let cachedPrefix = ROLE_INSTRUCTIONS;
  if (resumeText) cachedPrefix += "\n\n--- THE USER'S RESUME ---\n" + resumeText;
  if (jdText) cachedPrefix += '\n\n--- THE JOB THEY ARE INTERVIEWING FOR ---\n' + jdText;
  if (resumeText || jdText) {
    cachedPrefix +=
      '\n\nGround every answer in the resume and target role above. ' +
      'Never invent experience the resume does not support.';
  }

  // Fall back to `balanced` rather than splicing `undefined` into the prompt if
  // a stale/unvalidated style ever reaches us from the settings store.
  const styleSuffix = STYLE_INSTRUCTIONS[answerStyle] ?? STYLE_INSTRUCTIONS.balanced;
  return { cachedPrefix, styleSuffix };
}

/** The whole system prompt as one string, for providers without prompt caching. */
export function buildSystemPrompt(resume: string, jd: string, answerStyle: AnswerStyle): string {
  const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(resume, jd, answerStyle);
  return cachedPrefix + '\n\n' + styleSuffix;
}

/** The user turn wrapped around the transcript. Kept out of the system prompt so the cached prefix stays stable. */
export function buildUserMessage(transcript: string): string {
  return 'The other person on the call just said:\n"""\n' + transcript + '\n"""\n\nWhat should I say?';
}
```

## `src/shared/types.ts` lines 4–39

Settings types crossing the IPC bridge. Phase 1 adds `scenarios` / `activeScenarioId` and removes `jobDescription`.

```ts
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
```

## `src/main/store.ts` lines 19–73

Persisted shape, defaults, and the per-field-fallback schema. Phase 1 extends these and adds migration.

```ts
interface StoreShape {
  resume: string;
  jobDescription: string;
  alwaysOnTop: boolean;
  llmProvider: LlmProviderId;
  answerStyle: AnswerStyle;
  /** Electron accelerator; empty string means "no global shortcut". */
  hotkey: string;
  secrets: { deepgramKey?: string; anthropicKey?: string; groqKey?: string };
  /** Last window geometry, saved on close. Never exposed to the renderer. */
  windowBounds?: WindowBounds;
}

// A factory, not a shared constant. The previous module-level DEFAULTS object
// was aliased into the cache by `{ ...DEFAULTS, ...parsed }` whenever the file
// had no `secrets` key, so every saved API key mutated the defaults themselves.
function freshDefaults(): StoreShape {
  return {
    resume: '',
    jobDescription: '',
    alwaysOnTop: true,
    llmProvider: 'anthropic',
    answerStyle: 'balanced',
    hotkey: DEFAULT_HOTKEY,
    secrets: {},
  };
}

// settings.json is user-writable and survives upgrades, so it is untrusted
// input. Every field falls back to its default rather than failing the whole
// file: one bad value must not cost the user their resume or their API keys.
const persistedSchema = z.object({
  resume: z.string().catch(''),
  jobDescription: z.string().catch(''),
  alwaysOnTop: z.boolean().catch(true),
  llmProvider: z.enum(['anthropic', 'groq']).catch('anthropic'),
  answerStyle: z.enum(['brief', 'balanced', 'detailed']).catch('balanced'),
  hotkey: z.string().catch(DEFAULT_HOTKEY),
  secrets: z
    .object({
      deepgramKey: z.string().optional().catch(undefined),
      anthropicKey: z.string().optional().catch(undefined),
      groqKey: z.string().optional().catch(undefined),
    })
    .catch(() => ({})),
  windowBounds: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .catch(undefined),
});
```

## `src/main/ipc.ts` lines 11–24

Settings patch validation.

```ts
const settingsPatchSchema = z
  .object({
    resume: z.string().max(200_000),
    jobDescription: z.string().max(200_000),
    alwaysOnTop: z.boolean(),
    llmProvider: z.enum(['anthropic', 'groq']),
    answerStyle: z.enum(['brief', 'balanced', 'detailed']),
    // Electron accelerators are short; empty disables the shortcut.
    hotkey: z.string().max(100),
    deepgramKey: z.string().max(500),
    anthropicKey: z.string().max(500),
    groqKey: z.string().max(500),
  })
  .partial();
```

## `src/main/ipc.ts` lines 49–69

`createLlm`: where the prompt inputs are read from the store per request.

```ts
function createLlm(): LlmProvider {
  const { resume, jobDescription, llmProvider, answerStyle } = store.getProfile();
  if (llmProvider === 'groq') {
    const key = store.getSecret('groqKey');
    if (!key) {
      throw {
        code: 'no_llm_key',
        message: 'Groq API key is not set. Open Settings (gear icon) and add it, or switch the provider.',
      } satisfies AppError;
    }
    return createGroqProvider(key, resume, jobDescription, answerStyle);
  }
  const key = store.getSecret('anthropicKey');
  if (!key) {
    throw {
      code: 'no_llm_key',
      message: 'Anthropic API key is not set. Open Settings (gear icon) and add it.',
    } satisfies AppError;
  }
  return createAnthropicProvider(key, resume, jobDescription, answerStyle);
}
```

## `src/main/session.ts` lines 24–40

The provider interface and session dependencies. Phase 2 changes `generate` to take an `AnswerRequest`; Phase 3 adds a `priorTurns` dependency.

```ts
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
```

## `src/main/session.ts` lines 200–229

`streamAnswer`: the shared tail of the stop and ask paths, where the provider is created.

```ts
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
    const since = () => Math.round(performance.now() - t0);
    let firstTokenMs: number | null = null;
    // The renderer keys everything off the recorded-session event shape, so
    // the transcript always goes out as one already-final partial.
    this.deps.events.onSttPartial(s.id, transcript, true);
    const llm = this.deps.createLlm();
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
    });
  }
```

## `src/main/session.ts` lines 316–327

Where `generate` is called inside `runLlm` (timeouts wrap this call).

```ts
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
```

## `src/main/llm/anthropic.ts` lines 32–57

Anthropic request: two system blocks, cache breakpoint on the first, single user message.

```ts
export function createAnthropicProvider(
  apiKey: string,
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
): LlmProvider {
  // maxRetries: 0 — the SDK's default retry policy backs off for seconds, which
  // is forever in an interview. We do our own single, immediate, tightly-scoped
  // retry below instead.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(resume, jd, answerStyle);

  return {
    async generate(transcript, onDelta, signal) {
      // Built once so a retry re-sends byte-identical bytes and can still hit
      // the cache the first attempt may have written.
      const params: Anthropic.MessageStreamParams = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: 'text', text: cachedPrefix, cache_control: { type: 'ephemeral' } },
          // After the breakpoint: changing answerStyle costs nothing.
          { type: 'text', text: styleSuffix },
        ],
        messages: [{ role: 'user', content: buildUserMessage(transcript) }],
      };
```

## `src/main/llm/groq.ts` lines 33–56

Groq request: one joined system message, single user message.

```ts
export function createGroqProvider(
  apiKey: string,
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
): LlmProvider {
  const system = buildSystemPrompt(resume, jd, answerStyle);

  return {
    async generate(transcript, onDelta, signal) {
      // Serialized once so a retry re-sends byte-identical bytes (and does not
      // pay JSON.stringify twice) — same shape as the Anthropic provider.
      const body = JSON.stringify({
        model: MODEL,
        stream: true,
        temperature: 0.7,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        reasoning_effort: REASONING_EFFORT,
        include_reasoning: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: buildUserMessage(transcript) },
        ],
      });
```

## `src/renderer/ui-state.ts` lines 1–35

Per-state UI descriptor. `askLocked` is what disables the ask box while recording (gap G5).

```ts
// Pure map from app state to what the transport controls should show. No DOM —
// app.ts applies the descriptor, and the mapping is unit-testable in a plain
// node environment (test/history.test.ts, alongside the history module).

// 'starting' exists so a stop pressed while the session/capture is still coming
// up is honoured instead of silently dropped.
export type State = 'idle' | 'starting' | 'recording' | 'finalizing' | 'answering';

export interface StateUi {
  recordLabel: string;
  dotClass: string;
  statusText: string;
  /**
   * The ask box stays usable while an answer streams (asking aborts the old
   * session), but not while audio capture is in any stage of flight.
   */
  askLocked: boolean;
}

/** `readyText` is caller-supplied because the idle line names the live hotkey. */
export function stateUi(state: State, readyText: string): StateUi {
  const askLocked = state === 'starting' || state === 'recording' || state === 'finalizing';
  switch (state) {
    case 'idle':
      return { recordLabel: 'Record', dotClass: 'dot', statusText: readyText, askLocked };
    case 'starting':
      return { recordLabel: 'Starting…', dotClass: 'dot busy', statusText: 'Opening the microphone feed…', askLocked };
    case 'recording':
      return { recordLabel: 'Stop & Answer', dotClass: 'dot recording', statusText: 'Recording call audio…', askLocked };
    case 'finalizing':
      return { recordLabel: 'Record', dotClass: 'dot busy', statusText: 'Finalizing transcript…', askLocked };
    case 'answering':
      return { recordLabel: 'Record', dotClass: 'dot busy', statusText: 'Generating answer…', askLocked };
  }
}
```

## `src/main/stt/deepgram.ts` lines 19–22

The fixed Deepgram URL (gap G6). Phase 4 builds it from key terms.

```ts
const DEEPGRAM_URL =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-3&encoding=linear16&sample_rate=16000&channels=1' +
  '&interim_results=true&smart_format=true';
```
