import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_HOTKEY } from '../src/shared/types';
import { CONTEXT_LIMITS, createProfile, DEFAULT_OUTPUT } from '../src/shared/context';

// The store is the one main-process module that touches Electron directly, so
// it gets a fake userData dir and a fake keystore. `vi.hoisted` because the
// vi.mock factory is hoisted above these declarations.
const mocked = vi.hoisted(() => ({ userDataDir: '', encryptionAvailable: true }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
      return mocked.userDataDir;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => mocked.encryptionAvailable,
    // Stands in for DPAPI: reversible, but not the plaintext — so a test can
    // tell real encryption from a key written straight to disk.
    encryptString: (s: string) => Buffer.from(`dpapi:${Buffer.from(s, 'utf8').toString('hex')}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('dpapi:')) throw new Error('not decryptable on this machine');
      return Buffer.from(s.slice(6), 'hex').toString('utf8');
    },
  },
}));

type Store = typeof import('../src/main/store');

/** A store module with no module-level state carried over from another test. */
async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import('../src/main/store');
}

const settingsPath = () => path.join(mocked.userDataDir, 'settings.json');

function writeSettings(raw: unknown): void {
  fs.writeFileSync(settingsPath(), typeof raw === 'string' ? raw : JSON.stringify(raw));
}

function readSettings(): Record<string, unknown> & { secrets?: Record<string, string | undefined> } {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
}

// Tracked separately: a test may point userData at a subdirectory, and cleanup
// still has to take the whole tree with it.
let rootDir = '';

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-store-'));
  mocked.userDataDir = rootDir;
  mocked.encryptionAvailable = true;
});

afterEach(() => {
  vi.restoreAllMocks(); // fs spies must not leak into the next test's file IO
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** What the mocked safeStorage produces for `value`, as stored on disk. */
function encBlob(value: string): string {
  return 'enc:' + Buffer.from(`dpapi:${Buffer.from(value, 'utf8').toString('hex')}`, 'utf8').toString('base64');
}

describe('store defaults aliasing', () => {
  // Regression: load() used `{ ...DEFAULTS, ...JSON.parse(file) }`. A file with
  // no `secrets` key left cache.secrets pointing at the module-level
  // DEFAULTS.secrets, so saving a key mutated the defaults for the rest of the
  // process — and every later load inherited another profile's API keys.
  test('a settings.json without a secrets key does not poison the defaults', async () => {
    writeSettings({ resume: 'my resume' }); // legacy / hand-edited file: no `secrets`
    const store = await freshStore();

    store.applySettingsPatch({ deepgramKey: 'dg-live-secret' });
    expect(store.getSettingsView().hasDeepgramKey).toBe(true);

    // Same process, a settings.json that has never held a key.
    writeSettings({ resume: 'a different profile' });
    store.resetCacheForTests();

    expect(store.getSettingsView().hasDeepgramKey).toBe(false);
    expect(store.getSecret('deepgramKey')).toBe('');
  });

  test('clearing a key does not delete it out of the defaults either', async () => {
    writeSettings({ resume: 'r' }); // again: no `secrets` key
    const store = await freshStore();

    store.applySettingsPatch({ anthropicKey: 'sk-ant-1' });
    store.applySettingsPatch({ anthropicKey: '' });

    writeSettings({ secrets: { anthropicKey: 'plain:' + Buffer.from('sk-ant-2', 'utf8').toString('base64') } });
    store.resetCacheForTests();
    expect(store.getSecret('anthropicKey')).toBe('sk-ant-2');
  });
});

describe('store validation of settings.json', () => {
  test('hostile field types fall back to defaults instead of reaching typed code', async () => {
    writeSettings({
      resume: 42,
      jobDescription: { evil: true },
      alwaysOnTop: 'yes',
      llmProvider: 'evil-provider',
      answerStyle: 'novel-length',
      hotkey: 999,
      secrets: 'not-an-object',
    });
    const store = await freshStore();

    const v = store.getSettingsView();
    expect(v.resume).toBe('');
    expect(v.jobDescription).toBe('');
    expect(v.alwaysOnTop).toBe(true);
    expect(v.llmProvider).toBe('anthropic');
    expect(v.answerStyle).toBe('balanced');
    expect(v.hotkey).toBe(DEFAULT_HOTKEY);
    expect(v.hasDeepgramKey).toBe(false);

    // getProfile feeds the prompt builders and the provider switch: strings and
    // known ids only, whatever the file says.
    const profile = store.getProfile();
    expect(profile.resume).toBe('');
    expect(profile.llmProvider).toBe('anthropic');
    expect(profile.answerStyle).toBe('balanced');
  });

  test('one bad field does not cost the user the rest of the file', async () => {
    writeSettings({ resume: 'keep me', llmProvider: 'bogus', answerStyle: 'brief' });
    const store = await freshStore();

    const v = store.getSettingsView();
    expect(v.resume).toBe('keep me');
    expect(v.answerStyle).toBe('brief');
    expect(v.llmProvider).toBe('anthropic'); // only the bad field resets
  });

  test('a malformed entry inside secrets does not cost the other keys', async () => {
    writeSettings({
      resume: 'keep',
      secrets: { deepgramKey: 42, anthropicKey: encBlob('sk-keep'), groqKey: { nested: true } },
    });
    const store = await freshStore();

    const v = store.getSettingsView();
    expect(v.hasDeepgramKey).toBe(false); // bad type dropped
    expect(v.hasGroqKey).toBe(false); // bad type dropped
    expect(v.hasAnthropicKey).toBe(true); // good sibling survives
    expect(store.getSecret('anthropicKey')).toBe('sk-keep');
    expect(v.resume).toBe('keep');
  });

  test.each([
    ['unparseable json', 'garbage { not json'],
    ['a bare scalar', '"just a string"'],
    ['null', 'null'],
    ['an array', '[1, 2, 3]'],
  ])('%s loads as defaults rather than throwing at launch', async (_label, contents) => {
    writeSettings(contents);
    const store = await freshStore();

    expect(store.getSettingsView()).toMatchObject({
      resume: '',
      llmProvider: 'anthropic',
      answerStyle: 'balanced',
      hotkey: DEFAULT_HOTKEY,
      hasDeepgramKey: false,
    });
  });

  test('a missing settings.json is a first run, not an error', async () => {
    const store = await freshStore();
    expect(store.getSettingsView().resume).toBe('');
    expect(store.getAlwaysOnTop()).toBe(true);
  });
});

describe('store secrets', () => {
  test('keys round-trip through safeStorage and never hit disk in plaintext', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ deepgramKey: '  dg-key-123  ', anthropicKey: 'sk-ant-456' });

    expect(store.getSecret('deepgramKey')).toBe('dg-key-123'); // trimmed
    expect(store.getSecret('anthropicKey')).toBe('sk-ant-456');

    const onDisk = fs.readFileSync(settingsPath(), 'utf8');
    expect(onDisk).not.toContain('dg-key-123');
    expect(onDisk).not.toContain('sk-ant-456');
    expect(readSettings().secrets?.deepgramKey).toMatch(/^enc:/);

    // And they survive a restart.
    store.resetCacheForTests();
    expect(store.getSecret('deepgramKey')).toBe('dg-key-123');
  });

  test('the renderer view exposes presence flags only', async () => {
    const store = await freshStore();
    const view = store.applySettingsPatch({ groqKey: 'gsk-secret' });

    expect(view.hasGroqKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('gsk-secret');
  });

  test('an empty string clears a key; undefined leaves the others alone', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ deepgramKey: 'dg', anthropicKey: 'an' });
    store.applySettingsPatch({ deepgramKey: '' });

    const v = store.getSettingsView();
    expect(v.hasDeepgramKey).toBe(false);
    expect(v.hasAnthropicKey).toBe(true);
    expect(readSettings().secrets?.deepgramKey).toBeUndefined();
  });

  // Regression: the trim used to happen after the empty-string check, so a
  // pasted run of spaces encrypted '' — hasKey said "key present" while
  // getSecret returned '', and sessions failed with a confusing no-key error.
  test('a whitespace-only value clears the key like an empty string does', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ deepgramKey: 'dg-1' });
    store.applySettingsPatch({ deepgramKey: '   ' });

    expect(store.getSettingsView().hasDeepgramKey).toBe(false);
    expect(store.getSecret('deepgramKey')).toBe('');
    expect(readSettings().secrets?.deepgramKey).toBeUndefined();
  });

  test('a key copied from another machine is treated as unset, not a crash', async () => {
    writeSettings({ secrets: { deepgramKey: 'enc:' + Buffer.from('someone elses dpapi blob').toString('base64') } });
    const store = await freshStore();

    expect(() => store.getSecret('deepgramKey')).not.toThrow();
    expect(store.getSecret('deepgramKey')).toBe('');
    expect(store.getSettingsView().hasDeepgramKey).toBe(false);
  });

  test('an unrecognized storage prefix reads as unset instead of leaking the raw value', async () => {
    writeSettings({ secrets: { groqKey: 'v1$some-future-or-corrupt-format' } });
    const store = await freshStore();

    expect(store.getSecret('groqKey')).toBe('');
    expect(store.getSettingsView().hasGroqKey).toBe(false);
  });

  test('no plaintext and no ciphertext ever appears in the renderer view', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ deepgramKey: 'dg-p', anthropicKey: 'sk-ant-p', groqKey: 'gsk-p' });

    const serialized = JSON.stringify(store.getSettingsView());
    for (const leak of ['dg-p', 'sk-ant-p', 'gsk-p', 'enc:', 'plain:', 'secrets']) {
      expect(serialized).not.toContain(leak);
    }
  });

  test('falls back to marked plaintext when the OS keystore is unavailable', async () => {
    mocked.encryptionAvailable = false;
    const store = await freshStore();
    store.applySettingsPatch({ groqKey: 'gsk-1' });

    expect(readSettings().secrets?.groqKey).toMatch(/^plain:/);
    expect(store.getSecret('groqKey')).toBe('gsk-1');
  });

  test('a plain: fallback key still reads after the keystore comes back', async () => {
    // The stored prefix, not the keystore's current availability, selects the
    // decode path. If decryptKey keyed on isEncryptionAvailable instead, a key
    // saved during a keystore outage would silently vanish on the next launch.
    mocked.encryptionAvailable = false;
    const store = await freshStore();
    store.applySettingsPatch({ deepgramKey: 'dg-plain' });

    mocked.encryptionAvailable = true;
    store.resetCacheForTests();
    expect(store.getSecret('deepgramKey')).toBe('dg-plain');
  });

  test('getProfile exposes exactly the prompt inputs — never key material', async () => {
    // getProfile feeds the prompt builders, whose output is sent to LLM
    // providers; a key leaking into it would end up inside a network request body.
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r', anthropicKey: 'sk-ant-secret' });

    const profile = store.getProfile();
    expect(Object.keys(profile).sort()).toEqual(['answerStyle', 'jobDescription', 'llmProvider', 'resume']);
    expect(JSON.stringify(profile)).not.toContain('sk-ant-secret');
  });
});

describe('store patch semantics', () => {
  test('an empty patch changes nothing', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r', deepgramKey: 'dg' });
    const before = store.getSettingsView();

    expect(store.applySettingsPatch({})).toEqual(before);
    expect(store.getSecret('deepgramKey')).toBe('dg');
  });

  test('undefined fields are left untouched; only named fields change', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r1', jobDescription: 'jd1', answerStyle: 'brief', groqKey: 'gsk' });
    store.applySettingsPatch({ resume: 'r2' });

    const v = store.getSettingsView();
    expect(v.resume).toBe('r2');
    expect(v.jobDescription).toBe('jd1');
    expect(v.answerStyle).toBe('brief');
    expect(v.hasGroqKey).toBe(true);
  });

  test('resume and job description are stored verbatim, not trimmed', async () => {
    // Unlike keys and the hotkey, profile text formatting belongs to the user.
    const store = await freshStore();
    store.applySettingsPatch({ resume: '  indented resume\nline two  ' });
    store.resetCacheForTests();

    expect(store.getSettingsView().resume).toBe('  indented resume\nline two  ');
  });

  test('an empty string is a real value for plain fields, not a clear', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'something' });
    store.applySettingsPatch({ resume: '' });
    store.resetCacheForTests();

    expect(store.getSettingsView().resume).toBe('');
  });
});

describe('store answerStyle and hotkey', () => {
  test('default to balanced and the shared DEFAULT_HOTKEY', async () => {
    const store = await freshStore();
    const v = store.getSettingsView();
    expect(v.answerStyle).toBe('balanced');
    expect(v.hotkey).toBe(DEFAULT_HOTKEY);
    expect(store.getHotkey()).toBe(DEFAULT_HOTKEY);
  });

  test('persist across a reload', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ answerStyle: 'brief', hotkey: '  Control+Alt+K  ' });
    store.resetCacheForTests();

    const v = store.getSettingsView();
    expect(v.answerStyle).toBe('brief');
    expect(v.hotkey).toBe('Control+Alt+K'); // trimmed
    expect(store.getProfile().answerStyle).toBe('brief');
    expect(store.getHotkey()).toBe('Control+Alt+K');
  });

  test('an empty hotkey means "disabled" and must not spring back to the default', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ hotkey: '' });
    store.resetCacheForTests();

    expect(store.getHotkey()).toBe('');
    expect(store.getSettingsView().hotkey).toBe('');
  });

  test('a whitespace-only hotkey saves as "" (disabled), not as raw spaces', async () => {
    // main.ts treats '' as deliberately disabled; a run of spaces would instead
    // be handed to globalShortcut.register, which throws on the malformed
    // accelerator and reports a failed registration the user never asked for.
    const store = await freshStore();
    store.applySettingsPatch({ hotkey: '   ' });
    store.resetCacheForTests();

    expect(store.getHotkey()).toBe('');
    expect(store.getSettingsView().hotkey).toBe('');
  });
});

describe('store hotkeyRegistered', () => {
  test('reports the live registration state and is never persisted', async () => {
    const store = await freshStore();
    // Nothing has been registered yet this run.
    expect(store.getSettingsView().hotkeyRegistered).toBe(false);

    store.setHotkeyRegistered(true);
    expect(store.getSettingsView().hotkeyRegistered).toBe(true);

    // A failed registration (accelerator owned by another app) is reported truthfully.
    store.setHotkeyRegistered(false);
    expect(store.getSettingsView().hotkeyRegistered).toBe(false);

    store.setHotkeyRegistered(true);
    store.applySettingsPatch({ hotkey: 'Control+Alt+J' });
    expect(readSettings()).not.toHaveProperty('hotkeyRegistered');
  });

  test('resetCacheForTests drops the flag along with the cache', async () => {
    const store = await freshStore();
    store.setHotkeyRegistered(true);
    store.resetCacheForTests();

    // A fresh load must report "nothing registered yet this run".
    expect(store.getSettingsView().hotkeyRegistered).toBe(false);
  });
});

describe('store persistence', () => {
  // Regression: applySettingsPatch used to mutate the cache before persist(),
  // so a failed write left memory claiming a value the disk never got.
  test('a failed write does not leave the cache diverged from disk', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'saved' });

    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => store.applySettingsPatch({ resume: 'lost' })).toThrow('disk full');

    // In-memory state still matches what is actually on disk…
    expect(store.getSettingsView().resume).toBe('saved');
    // …and the disk really does hold the old value.
    store.resetCacheForTests();
    expect(store.getSettingsView().resume).toBe('saved');
  });

  test('writes atomically and leaves no partial file behind', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r' });

    expect(fs.existsSync(`${settingsPath()}.tmp`)).toBe(false);
    expect(readSettings().resume).toBe('r');
  });

  test('persists by writing a tmp file first and renaming it over settings.json', async () => {
    const store = await freshStore();
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    store.applySettingsPatch({ resume: 'r' });

    // The real file is only ever touched by the rename, never a direct write.
    const tmp = `${settingsPath()}.tmp`;
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(tmp, expect.stringContaining('"resume": "r"'));
    expect(renameSpy).toHaveBeenCalledExactlyOnceWith(tmp, settingsPath());
    expect(writeSpy.mock.invocationCallOrder[0]!).toBeLessThan(renameSpy.mock.invocationCallOrder[0]!);
  });

  test('reading settings never creates the file — only a save does', async () => {
    const store = await freshStore();
    store.getSettingsView();
    store.getProfile();
    expect(fs.existsSync(settingsPath())).toBe(false);

    store.applySettingsPatch({ alwaysOnTop: false });
    expect(fs.existsSync(settingsPath())).toBe(true);
    expect(store.getAlwaysOnTop()).toBe(false);
  });

  test('creates the userData directory on first save', async () => {
    mocked.userDataDir = path.join(mocked.userDataDir, 'nested', 'never-created');
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r' });

    expect(readSettings().resume).toBe('r');
  });
});

describe('store window bounds', () => {
  test('round-trips geometry through disk', async () => {
    const store = await freshStore();
    expect(store.getWindowBounds()).toBeUndefined(); // first run: nothing saved

    store.setWindowBounds({ x: 120, y: 80, width: 500, height: 720 });
    expect(store.getWindowBounds()).toEqual({ x: 120, y: 80, width: 500, height: 720 });

    // Survives a cold read, not just the in-memory cache.
    store.resetCacheForTests();
    expect(store.getWindowBounds()).toEqual({ x: 120, y: 80, width: 500, height: 720 });
  });

  test('negative positions persist — displays left of the primary are real', async () => {
    const store = await freshStore();
    store.setWindowBounds({ x: -1500, y: -20, width: 460, height: 700 });
    store.resetCacheForTests();
    expect(store.getWindowBounds()).toEqual({ x: -1500, y: -20, width: 460, height: 700 });
  });

  test('a corrupt windowBounds field falls back to undefined without costing other settings', async () => {
    writeSettings({
      resume: 'kept',
      windowBounds: { x: 'left', y: 0, width: -5, height: 700 },
    });
    const store = await freshStore();

    expect(store.getWindowBounds()).toBeUndefined();
    expect(store.getSettingsView().resume).toBe('kept'); // per-field fallback held
  });

  test('bounds never reach the renderer settings view', async () => {
    const store = await freshStore();
    store.setWindowBounds({ x: 1, y: 2, width: 460, height: 700 });
    expect(store.getSettingsView()).not.toHaveProperty('windowBounds');
  });

  test('the returned bounds never alias the cache', async () => {
    const store = await freshStore();
    store.setWindowBounds({ x: 10, y: 10, width: 460, height: 700 });
    const a = store.getWindowBounds()!;
    a.x = 9999;
    expect(store.getWindowBounds()!.x).toBe(10);
  });

  test('setWindowBounds copies its argument instead of aliasing it', async () => {
    // main.ts reuses bounds objects across the debounced save path; the cache
    // holding a live reference would let a later mutation rewrite what "was
    // saved" without a persist.
    const store = await freshStore();
    const b = { x: 10, y: 20, width: 460, height: 700 };
    store.setWindowBounds(b);
    b.x = 9999;
    expect(store.getWindowBounds()!.x).toBe(10);
  });

  test('fractional window bounds on disk are dropped as a unit, other fields kept', async () => {
    // getNormalBounds only ever yields integers, so fractions on disk mean a
    // hand edit or corruption — distrust the whole geometry (Electron centers
    // instead) rather than round someone else's guess, and keep the rest of
    // the file per the per-field fallback rule.
    writeSettings({ resume: 'kept', windowBounds: { x: 10.5, y: 0, width: 460, height: 700 } });
    const store = await freshStore();

    expect(store.getWindowBounds()).toBeUndefined();
    expect(store.getSettingsView().resume).toBe('kept');
  });

  test('a failed write is swallowed — saving geometry must never break shutdown', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'saved' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    // Called from the window close handler: it must not throw…
    expect(() => store.setWindowBounds({ x: 5, y: 5, width: 460, height: 700 })).not.toThrow();
    // …and the cache still matches the disk (the write never landed).
    store.resetCacheForTests();
    expect(store.getWindowBounds()).toBeUndefined();
    expect(store.getSettingsView().resume).toBe('saved');
  });

  test('saving other settings preserves previously saved bounds', async () => {
    const store = await freshStore();
    store.setWindowBounds({ x: 30, y: 40, width: 470, height: 710 });
    store.applySettingsPatch({ resume: 'new resume' });
    store.resetCacheForTests();
    expect(store.getWindowBounds()).toEqual({ x: 30, y: 40, width: 470, height: 710 });
  });
});

describe('store context profiles', () => {
  test('legacy answer style changes target the active profile and preserve other profiles', async () => {
    const store = await freshStore();
    const interview = store.getSettingsView().contextProfiles![0]!;
    store.applySettingsPatch({ contextProfiles: [interview, createProfile('client', 'client')], activeProfileId: 'client' });
    store.applySettingsPatch({ answerStyle: 'brief' });
    const view = store.getSettingsView();
    expect(view.contextProfiles?.find((p) => p.id === 'client')?.output.answerStyle).toBe('brief');
    expect(view.contextProfiles?.find((p) => p.id === 'interview')).toEqual(interview);
    expect(view.outputDefaults?.answerStyle).toBe('brief');
  });

  test('migrates legacy references and style into an Interview profile without rewriting on read', async () => {
    const legacy = { resume: '  resume\nkept  ', jobDescription: '  job  ', answerStyle: 'brief' };
    writeSettings(legacy);
    const store = await freshStore();
    const view = store.getSettingsView();
    expect(view).toMatchObject({ ...legacy, activeProfileId: 'interview' });
    expect(view.contextProfiles).toEqual([expect.objectContaining({
      id: 'interview', name: 'Interview', situation: 'interview',
      includeResume: true, includeJobDescription: true, output: { answerStyle: 'brief' },
    })]);
    expect(view.outputDefaults?.answerStyle).toBe('brief');
    expect(readSettings()).toEqual(legacy);
    store.applySettingsPatch({ alwaysOnTop: false });
    store.resetCacheForTests();
    expect(store.getSettingsView().contextProfiles).toEqual(view.contextProfiles);
    expect(store.getSettingsView().resume).toBe(legacy.resume);
  });

  test('round-trips saved profiles, selection, and output defaults through disk', async () => {
    const store = await freshStore();
    const profile = { ...createProfile('client', 'client-a', 'Renewal'), background: 'Current contract', output: { tone: 'diplomatic' as const } };
    store.applySettingsPatch({
      contextProfiles: [profile], activeProfileId: profile.id,
      outputDefaults: { ...DEFAULT_OUTPUT, audience: 'nontechnical', answerStyle: 'detailed' },
    });
    store.resetCacheForTests();
    expect(store.getSettingsView()).toMatchObject({
      contextProfiles: [profile], activeProfileId: 'client-a',
      outputDefaults: { ...DEFAULT_OUTPUT, audience: 'nontechnical', answerStyle: 'detailed' },
    });
  });

  test('recovers corrupt profile and output fields without losing valid siblings', async () => {
    const technical = createProfile('technical', 'tech');
    const client = { ...createProfile('client', 'client'), background: 'Keep client facts' };
    writeSettings({
      resume: 'Legacy reference',
      contextProfiles: [null, { ...technical, background: 42, name: '', output: { tone: 'invalid', format: 'star' } }, client],
      activeProfileId: 'missing',
      outputDefaults: { answerStyle: 'brief', tone: 'invalid', audience: 'technical', format: 'star' },
    });
    const store = await freshStore();
    const view = store.getSettingsView();
    expect(view.contextProfiles).toEqual([
      { ...technical, background: '', output: { format: 'star' } }, client,
    ]);
    expect(view.activeProfileId).toBe('tech');
    expect(view.resume).toBe('Legacy reference');
    expect(view.outputDefaults).toEqual({ ...DEFAULT_OUTPUT, answerStyle: 'brief', audience: 'technical', format: 'star' });
  });

  test('recovers duplicate and excessive persisted profiles while preserving valid IDs', async () => {
    const profiles = Array.from({ length: CONTEXT_LIMITS.profiles + 2 }, (_, index) => createProfile('custom', `profile-${index}`));
    writeSettings({ contextProfiles: [profiles[0], profiles[0], ...profiles.slice(1)], activeProfileId: 'profile-1' });
    const view = (await freshStore()).getSettingsView();
    expect(view.contextProfiles).toHaveLength(CONTEXT_LIMITS.profiles);
    expect(new Set(view.contextProfiles?.map((p) => p.id)).size).toBe(CONTEXT_LIMITS.profiles);
    expect(view.activeProfileId).toBe('profile-1');
  });

  test.each([null, [], [{ id: '' }], 'invalid'])('falls back to migrated Interview when no usable profile remains: %j', async (contextProfiles) => {
    writeSettings({ contextProfiles, answerStyle: 'detailed', resume: 'kept' });
    const view = (await freshStore()).getSettingsView();
    expect(view.contextProfiles).toEqual([expect.objectContaining({ id: 'interview', output: { answerStyle: 'detailed' } })]);
    expect(view.resume).toBe('kept');
  });

  test('rejects duplicate IDs, empty lists, oversized fields, and missing active IDs before writing', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'saved' });
    const before = store.getSettingsView();
    const diskBefore = fs.readFileSync(settingsPath(), 'utf8');
    const profile = createProfile('custom', 'new');
    for (const patch of [
      { contextProfiles: [] },
      { contextProfiles: [profile, profile], activeProfileId: 'new' },
      { contextProfiles: [{ ...profile, background: 'x'.repeat(CONTEXT_LIMITS.background + 1) }], activeProfileId: 'new' },
      { contextProfiles: [profile] },
      { activeProfileId: 'missing' },
    ]) {
      expect(() => store.applySettingsPatch(patch)).toThrow();
      expect(store.getSettingsView()).toEqual(before);
      expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(diskBefore);
    }
  });

  test('profile arguments and returned nested settings never alias cached data', async () => {
    const store = await freshStore();
    const profile = { ...createProfile('custom', 'new'), output: { tone: 'diplomatic' as const } };
    const outputDefaults = { ...DEFAULT_OUTPUT };
    const view = store.applySettingsPatch({ contextProfiles: [profile], activeProfileId: 'new', outputDefaults });
    profile.background = 'mutated argument';
    profile.output.tone = 'confident' as typeof profile.output.tone;
    outputDefaults.answerStyle = 'brief';
    view.contextProfiles![0]!.background = 'mutated result';
    view.contextProfiles![0]!.output.tone = 'conversational';
    view.outputDefaults!.format = 'star';
    expect(store.getSettingsView()).toMatchObject({
      contextProfiles: [{ background: '', output: { tone: 'diplomatic' } }], outputDefaults: DEFAULT_OUTPUT,
    });
  });

  test('failed nested profile updates preserve both memory and disk', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'saved' });
    const before = store.getSettingsView();
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => store.applySettingsPatch({
      contextProfiles: [createProfile('meeting', 'meeting')], activeProfileId: 'meeting',
      outputDefaults: { ...DEFAULT_OUTPUT, answerStyle: 'detailed' },
    })).toThrow('disk full');
    expect(store.getSettingsView()).toEqual(before);
    store.resetCacheForTests();
    expect(store.getSettingsView()).toEqual(before);
  });
});

describe('store usable credentials and encryption reporting', () => {
  test('empty, whitespace, and malformed stored credentials are not reported as usable', async () => {
    writeSettings({ secrets: {
      deepgramKey: encBlob('  '), anthropicKey: 'plain:!!!!', groqKey: encBlob('invalid\nkey'),
    } });
    expect((await freshStore()).getSettingsView()).toMatchObject({
      hasDeepgramKey: false, hasAnthropicKey: false, hasGroqKey: false, keyStorage: 'none',
    });
  });

  test('reports plaintext fallback and mixed storage until plaintext keys are replaced', async () => {
    const store = await freshStore();
    expect(store.getSettingsView().keyStorage).toBe('none');
    mocked.encryptionAvailable = false;
    expect(store.applySettingsPatch({ deepgramKey: 'dg' }).keyStorage).toBe('plaintext');
    mocked.encryptionAvailable = true;
    expect(store.applySettingsPatch({ anthropicKey: 'ant' }).keyStorage).toBe('mixed');
    expect(store.applySettingsPatch({ deepgramKey: 'dg-new' }).keyStorage).toBe('encrypted');
  });
});
