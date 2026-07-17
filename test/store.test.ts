import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_HOTKEY } from '../src/shared/types';

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
  fs.rmSync(rootDir, { recursive: true, force: true });
});

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

  test('a key copied from another machine is treated as unset, not a crash', async () => {
    writeSettings({ secrets: { deepgramKey: 'enc:' + Buffer.from('someone elses dpapi blob').toString('base64') } });
    const store = await freshStore();

    expect(() => store.getSecret('deepgramKey')).not.toThrow();
    expect(store.getSecret('deepgramKey')).toBe('');
  });

  test('falls back to marked plaintext when the OS keystore is unavailable', async () => {
    mocked.encryptionAvailable = false;
    const store = await freshStore();
    store.applySettingsPatch({ groqKey: 'gsk-1' });

    expect(readSettings().secrets?.groqKey).toMatch(/^plain:/);
    expect(store.getSecret('groqKey')).toBe('gsk-1');
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
});

describe('store persistence', () => {
  test('writes atomically and leaves no partial file behind', async () => {
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r' });

    expect(fs.existsSync(`${settingsPath()}.tmp`)).toBe(false);
    expect(readSettings().resume).toBe('r');
  });

  test('creates the userData directory on first save', async () => {
    mocked.userDataDir = path.join(mocked.userDataDir, 'nested', 'never-created');
    const store = await freshStore();
    store.applySettingsPatch({ resume: 'r' });

    expect(readSettings().resume).toBe('r');
  });
});
