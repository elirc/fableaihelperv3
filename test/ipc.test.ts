import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  patch: vi.fn(),
  generate: vi.fn(),
  provider: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mocks.handlers.set(name, fn), on: vi.fn() } }));
vi.mock('../src/main/store', () => ({
  getProfile: () => ({ resume: 'Resume', jobDescription: 'Role', personalProfile: 'Python developer', customInstructions: 'Use Python examples', llmProvider: 'groq', groqModel: 'openai/gpt-oss-120b', answerStyle: 'brief' }),
  getSecret: () => 'fake-test-key',
  getSettingsView: () => ({}),
  applySettingsPatch: mocks.patch,
}));
vi.mock('../src/main/llm/groq', () => ({ createGroqProvider: mocks.provider }));
vi.mock('../src/main/llm/warm', () => ({ warmLlmConnection: vi.fn() }));
import { registerIpc } from '../src/main/ipc';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.provider.mockReturnValue({ generate: mocks.generate });
  mocks.generate.mockImplementation(async (_text, delta) => { delta('Answer'); return 'Answer'; });
  registerIpc(() => ({ webContents: { isDestroyed: () => false, send: mocks.send } }) as any, vi.fn());
});

describe('personalization and follow-up IPC', () => {
  test('accepts customization and rejects oversized updates before writing', () => {
    const save = mocks.handlers.get('settings:set')!;
    save(null, { personalProfile: 'Engineer', customInstructions: 'Be direct.' });
    expect(mocks.patch).toHaveBeenCalledWith({ personalProfile: 'Engineer', customInstructions: 'Be direct.' });
    expect(() => save(null, { personalProfile: 'x'.repeat(12001) })).toThrow();
    expect(() => save(null, { customInstructions: 'x'.repeat(8001) })).toThrow();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });

  test('routes the saved profile and validated follow-up through the session to Groq', async () => {
    const options = { context: [{ question: 'What is caching?', answer: 'Reusing stored results.' }], answerStyle: 'detailed' };
    const result = await mocks.handlers.get('session:ask')!(null, ' Show an example ', options);
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith('llm:done', expect.objectContaining({ answer: 'Answer' })));
    expect(mocks.provider).toHaveBeenCalledWith('fake-test-key', 'Resume', 'Role', 'brief', 'openai/gpt-oss-120b', { personalProfile: 'Python developer', customInstructions: 'Use Python examples' });
    expect(mocks.generate.mock.calls[0]?.[0]).toBe('Show an example');
    expect(mocks.generate.mock.calls[0]?.[4]).toEqual(options);
  });

  test.each([
    { context: [{ question: 'Question', answer: '' }] },
    { context: Array.from({ length: 7 }, () => ({ question: 'Q', answer: 'A' })) },
    { context: [{ question: 'Q', answer: 'x'.repeat(20001) }] },
    { answerStyle: 'invalid' },
  ])('rejects malformed or oversized context without creating an answer', async (options) => {
    const result = await mocks.handlers.get('session:ask')!(null, 'Explain more', options);
    expect(result.ok).toBe(false);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
