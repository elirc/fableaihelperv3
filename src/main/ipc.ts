import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import type { AppError, ContextSnapshot, LlmProviderId, Result } from '../shared/types';
import { CONTEXT_LIMITS, resolveContext } from '../shared/context';
import { answerOptionsSchema, contextSnapshotSchema, contextProfilesSchema, outputPreferencesSchema } from './context-schema';
import * as store from './store';
import { SessionManager, toAppError, type LlmProvider, type SttStream } from './session';
import { DeepgramStream } from './stt/deepgram';
import { createAnthropicProvider } from './llm/anthropic';
import { createGroqProvider } from './llm/groq';
import { warmLlmConnection } from './llm/warm';

const settingsPatchSchema = z
  .object({
    resume: z.string().max(200_000),
    jobDescription: z.string().max(200_000),
    alwaysOnTop: z.boolean(),
    llmProvider: z.enum(['anthropic', 'groq']),
    answerStyle: z.enum(['brief', 'balanced', 'detailed']),
    contextProfiles: contextProfilesSchema,
    activeProfileId: z.string().min(1).max(CONTEXT_LIMITS.id),
    outputDefaults: outputPreferencesSchema,
    // Electron accelerators are short; empty disables the shortcut.
    hotkey: z.string().max(100),
    deepgramKey: z.string().max(500),
    anthropicKey: z.string().max(500),
    groqKey: z.string().max(500),
  })
  .partial();

const sessionIdSchema = z.number().int().positive();
// A typed question: non-empty once trimmed, and bounded so a paste accident
// cannot ship a novel to the LLM.
const askTextSchema = z.string().trim().min(1).max(8_000);

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function fail<T>(error: AppError): Result<T> {
  return { ok: false, error };
}

function requestError(error: unknown, fallback: AppError['code']): AppError {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return { code: 'internal', message: issue
      ? `Check ${issue.path.join('.') || 'answer options'}: ${issue.message}`
      : 'Check the answer options and try again.' };
  }
  return toAppError(error, fallback);
}

async function createStt(): Promise<SttStream> {
  const key = store.getSecret('deepgramKey');
  if (!key) {
    throw {
      code: 'no_stt_key',
      message: 'Deepgram API key is not set. Open Settings (gear icon) and add it.',
    } satisfies AppError;
  }
  return DeepgramStream.connect(key);
}

function createLlm(context?: ContextSnapshot, provider?: LlmProviderId): LlmProvider {
  const llmProvider = provider ?? store.getProfile().llmProvider;
  const snapshot = context ?? resolveContext(store.getSettingsView());
  if (llmProvider === 'groq') {
    const key = store.getSecret('groqKey');
    if (!key) {
      throw {
        code: 'no_llm_key',
        message: 'Groq API key is not set. Open Settings (gear icon) and add it, or switch the provider.',
      } satisfies AppError;
    }
    return createGroqProvider(key, snapshot);
  }
  const key = store.getSecret('anthropicKey');
  if (!key) {
    throw {
      code: 'no_llm_key',
      message: 'Anthropic API key is not set. Open Settings (gear icon) and add it.',
    } satisfies AppError;
  }
  return createAnthropicProvider(key, snapshot);
}

/**
 * @param getWin           the live window, or null once it is gone
 * @param applyHotkey      re-reads the stored hotkey and (re)registers the
 *                         global shortcut, recording the real outcome in store
 */
export function registerIpc(getWin: () => BrowserWindow | null, applyHotkey: () => void): void {
  const send = (channel: string, payload: unknown) => {
    const win = getWin();
    if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };

  const sessions = new SessionManager({
    createStt,
    createLlm,
    events: {
      onSttPartial: (sessionId, text, isFinal) => send('stt:partial', { sessionId, text, isFinal }),
      onLlmDelta: (sessionId, delta) => send('llm:delta', { sessionId, delta }),
      onLlmDone: (sessionId, transcript, answer, metrics, context) =>
        send('llm:done', { sessionId, transcript, answer, metrics, context }),
      onError: (sessionId, error) => send('session:error', { sessionId, error }),
    },
  });

  ipcMain.handle('settings:get', () => store.getSettingsView());

  ipcMain.handle('settings:set', (_e, raw) => {
    const patch = settingsPatchSchema.parse(raw);
    store.applySettingsPatch(patch);
    const win = getWin();
    if (win && patch.alwaysOnTop !== undefined) win.setAlwaysOnTop(patch.alwaysOnTop);
    // Re-register before building the view: hotkeyRegistered must describe the
    // accelerator the user just saved, not the one it replaced.
    if (patch.hotkey !== undefined) applyHotkey();
    return store.getSettingsView();
  });

  ipcMain.handle('session:start', async (_e, rawOptions): Promise<Result<number>> => {
    // Pre-warm the LLM origin while the user is still recording: the TCP+TLS
    // handshake completes in the background, so the answer request after Stop
    // reuses a pooled connection instead of paying it inside the
    // stop-to-first-word window. Fire-and-forget, internally throttled.
    try {
      const options = answerOptionsSchema.parse(rawOptions ?? {});
      const settings = store.getSettingsView();
      const context = contextSnapshotSchema.parse(resolveContext(settings, options));
      const provider = settings.llmProvider;
      warmLlmConnection(provider);
      return ok(await sessions.start(context, provider));
    } catch (err) {
      return fail(requestError(err, 'stt_connect'));
    }
  });

  ipcMain.handle('session:ask', async (_e, raw, rawOptions): Promise<Result<number>> => {
    // Typed questions skip STT entirely, so the LLM handshake is the whole
    // pre-answer critical path — start it before the session even spins up.
    try {
      const text = askTextSchema.parse(raw);
      const options = answerOptionsSchema.parse(rawOptions ?? {});
      const settings = store.getSettingsView();
      const context = contextSnapshotSchema.parse(resolveContext(settings, options));
      const provider = settings.llmProvider;
      warmLlmConnection(provider);
      return ok(await sessions.ask(text, context, provider));
    } catch (err) {
      return fail(requestError(err, 'internal'));
    }
  });

  // Fire-and-forget for throughput: one message per ~128ms audio frame.
  ipcMain.on('audio:chunk', (_e, raw: unknown, pcm: unknown) => {
    // Deliberately not zod: this is the one per-frame handler (~8/s for the
    // whole recording), and safeParse allocates a result object per call for a
    // check that is two comparisons. Number.isInteger implies typeof number and
    // rejects NaN/Infinity/boxed Numbers — the same set sessionIdSchema refuses.
    if (!Number.isInteger(raw) || (raw as number) <= 0 || !(pcm instanceof ArrayBuffer)) return;
    sessions.audio(raw as number, pcm);
  });

  ipcMain.handle('session:stop', async (_e, raw): Promise<Result<null>> => {
    const sessionId = sessionIdSchema.parse(raw);
    // The highest-value warm: fired BEFORE awaiting stop, so the TLS handshake
    // overlaps the STT finalize and the LLM request that follows lands on a
    // connection that is already hot.
    warmLlmConnection(sessions.providerFor(sessionId) ?? store.getProfile().llmProvider);
    // Pipeline errors arrive as session:error events, so stop itself normally
    // "succeeds". The exception is a session the manager no longer has: the
    // renderer is waiting on events that will never fire, so the only way it
    // learns is this result. Without it the UI sits in "Finalizing…" forever.
    if (!(await sessions.stop(sessionId))) {
      return fail({
        code: 'internal',
        message: 'That recording already ended. Press Record to ask again.',
      });
    }
    return ok(null);
  });

  ipcMain.handle('session:cancel', (_e, raw) => {
    // safeParse: cancel is fire-and-forget in the renderer (`void
    // api.cancelSession(...)`), so a thrown validation error would surface as
    // an unhandled rejection instead of anything actionable. A bad id simply
    // cancels nothing.
    const sessionId = sessionIdSchema.safeParse(raw);
    if (sessionId.success) sessions.cancel(sessionId.data);
  });
}
