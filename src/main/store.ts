import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ANTHROPIC_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_HOTKEY,
  GROQ_MODELS,
  type AnswerStyle,
  type AnthropicModelId,
  type AudioSource,
  type GroqModelId,
  type LlmProviderId,
  type SettingsPatch,
  type SettingsView,
} from '../shared/types';

// JSON settings store in %APPDATA%/AI Call Assistant/settings.json. The
// directory keeps the v1 productName on purpose (see README): renaming it would
// move userData and silently orphan the user's encrypted keys and profile.
// Plain fields are stored as-is; API keys are encrypted with Electron
// safeStorage (DPAPI on Windows) and stored base64 under `secrets`.
// Keys are never returned to the renderer — SettingsView carries hasKey flags only.

interface StoreShape {
  resume: string;
  jobDescription: string;
  personalProfile: string;
  customInstructions: string;
  alwaysOnTop: boolean;
  llmProvider: LlmProviderId;
  anthropicModel: AnthropicModelId;
  groqModel: GroqModelId;
  audioSource: AudioSource;
  answerStyle: AnswerStyle;
  /** Electron accelerator; empty string means "no global shortcut". */
  hotkey: string;
  secrets: { deepgramKey?: string; anthropicKey?: string; groqKey?: string };
}

// A factory, not a shared constant. The previous module-level DEFAULTS object
// was aliased into the cache by `{ ...DEFAULTS, ...parsed }` whenever the file
// had no `secrets` key, so every saved API key mutated the defaults themselves.
function freshDefaults(): StoreShape {
  return {
    resume: '',
    jobDescription: '',
    personalProfile: '',
    customInstructions: '',
    alwaysOnTop: true,
    llmProvider: 'anthropic',
    anthropicModel: DEFAULT_ANTHROPIC_MODEL,
    groqModel: DEFAULT_GROQ_MODEL,
    audioSource: 'microphone',
    answerStyle: 'brief',
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
  personalProfile: z.string().max(12_000).catch(''),
  customInstructions: z.string().max(8_000).catch(''),
  alwaysOnTop: z.boolean().catch(true),
  llmProvider: z.enum(['anthropic', 'groq']).catch('anthropic'),
  // Model picks fall back to the defaults rather than failing: an entry removed
  // from the curated list in a future version must not brick the settings file.
  anthropicModel: z.enum(ANTHROPIC_MODELS).catch(DEFAULT_ANTHROPIC_MODEL),
  groqModel: z.enum(GROQ_MODELS).catch(DEFAULT_GROQ_MODEL),
  audioSource: z.enum(['microphone', 'system']).catch('microphone'),
  answerStyle: z.enum(['brief', 'balanced', 'detailed']).catch('brief'),
  hotkey: z.string().catch(DEFAULT_HOTKEY),
  secrets: z
    .object({
      deepgramKey: z.string().optional().catch(undefined),
      anthropicKey: z.string().optional().catch(undefined),
      groqKey: z.string().optional().catch(undefined),
    })
    .catch(() => ({})),
});

let cache: StoreShape | null = null;

// Live registration state of the global shortcut — deliberately not persisted.
// It is a fact about this run (an accelerator owned by another app today may be
// free tomorrow), so main.ts reports the real result of each register attempt.
let hotkeyRegistered = false;

function filePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readFromDisk(): StoreShape {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    return freshDefaults(); // missing (first run) or unreadable/invalid JSON
  }
  const parsed = persistedSchema.safeParse(raw);
  if (!parsed.success) return freshDefaults(); // not an object at all
  const d = parsed.data;
  return {
    resume: d.resume,
    jobDescription: d.jobDescription,
    personalProfile: d.personalProfile,
    customInstructions: d.customInstructions,
    alwaysOnTop: d.alwaysOnTop,
    llmProvider: d.llmProvider,
    anthropicModel: d.anthropicModel,
    groqModel: d.groqModel,
    audioSource: d.audioSource,
    answerStyle: d.answerStyle,
    hotkey: d.hotkey,
    // Copy: the cache must never share a reference with anything it did not build.
    secrets: { ...d.secrets },
  };
}

function load(): StoreShape {
  if (!cache) cache = readFromDisk();
  return cache;
}

function persist(s: StoreShape): void {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write-then-rename: a crash or full disk mid-write would otherwise leave a
  // truncated settings.json, which now parses as "defaults" and silently costs
  // the user every setting they have, encrypted keys included.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, target);
}

// safeStorage needs app to be ready; fall back to a marked plaintext value if
// the OS keystore is unavailable (should not happen on Windows).
function encryptKey(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return 'plain:' + Buffer.from(value, 'utf8').toString('base64');
}

function decryptKey(stored: string | undefined): string {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    }
  } catch {
    // Undecryptable (e.g. copied from another machine) — treat as unset.
  }
  return '';
}

export function getSettingsView(): SettingsView {
  const s = load();
  return {
    resume: s.resume,
    jobDescription: s.jobDescription,
    personalProfile: s.personalProfile,
    customInstructions: s.customInstructions,
    alwaysOnTop: s.alwaysOnTop,
    llmProvider: s.llmProvider,
    anthropicModel: s.anthropicModel,
    groqModel: s.groqModel,
    audioSource: s.audioSource,
    answerStyle: s.answerStyle,
    hotkey: s.hotkey,
    hotkeyRegistered,
    hasDeepgramKey: !!s.secrets.deepgramKey,
    hasAnthropicKey: !!s.secrets.anthropicKey,
    hasGroqKey: !!s.secrets.groqKey,
  };
}

export function applySettingsPatch(patch: SettingsPatch): SettingsView {
  const cur = load();
  // Work on a copy and commit only after the write lands: if encryptKey or
  // persist throws (keystore hiccup, disk full), the cache still matches disk
  // instead of holding a half-applied patch the next launch silently loses.
  const s: StoreShape = { ...cur, secrets: { ...cur.secrets } };
  if (patch.resume !== undefined) s.resume = patch.resume;
  if (patch.jobDescription !== undefined) s.jobDescription = patch.jobDescription;
  if (patch.personalProfile !== undefined) s.personalProfile = patch.personalProfile;
  if (patch.customInstructions !== undefined) s.customInstructions = patch.customInstructions;
  if (patch.alwaysOnTop !== undefined) s.alwaysOnTop = patch.alwaysOnTop;
  if (patch.llmProvider !== undefined) s.llmProvider = patch.llmProvider;
  if (patch.anthropicModel !== undefined) s.anthropicModel = patch.anthropicModel;
  if (patch.groqModel !== undefined) s.groqModel = patch.groqModel;
  if (patch.audioSource !== undefined) s.audioSource = patch.audioSource;
  if (patch.answerStyle !== undefined) s.answerStyle = patch.answerStyle;
  if (patch.hotkey !== undefined) s.hotkey = patch.hotkey.trim();
  for (const key of ['deepgramKey', 'anthropicKey', 'groqKey'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    // Trim before the empty check: a pasted run of spaces must clear the key,
    // not encrypt '' and leave hasKey claiming a key that cannot authenticate.
    const trimmed = v.trim();
    if (trimmed === '') delete s.secrets[key];
    else s.secrets[key] = encryptKey(trimmed);
  }
  persist(s);
  cache = s;
  return getSettingsView();
}

export function getSecret(key: 'deepgramKey' | 'anthropicKey' | 'groqKey'): string {
  return decryptKey(load().secrets[key]);
}

export function getProfile(): {
  resume: string;
  jobDescription: string;
  personalProfile: string;
  customInstructions: string;
  llmProvider: LlmProviderId;
  anthropicModel: AnthropicModelId;
  groqModel: GroqModelId;
  answerStyle: AnswerStyle;
} {
  const s = load();
  return {
    resume: s.resume,
    jobDescription: s.jobDescription,
    personalProfile: s.personalProfile,
    customInstructions: s.customInstructions,
    llmProvider: s.llmProvider,
    anthropicModel: s.anthropicModel,
    groqModel: s.groqModel,
    answerStyle: s.answerStyle,
  };
}

export function getAlwaysOnTop(): boolean {
  return load().alwaysOnTop;
}

export function getHotkey(): string {
  return load().hotkey;
}

/** Called by main.ts with the real outcome of globalShortcut.register(). */
export function setHotkeyRegistered(value: boolean): void {
  hotkeyRegistered = value;
}

/** @internal Test seam: drops the in-memory cache so the next read hits disk. */
export function resetCacheForTests(): void {
  cache = null;
  hotkeyRegistered = false;
}
