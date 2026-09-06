// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RendererApi, SettingsPatch, SettingsView } from '../src/shared/types';

const html = readFileSync('src/renderer/index.html', 'utf8');
// Only load the DOM fixture; app.ts is imported below and no assets need fetching.
const bodyHtml = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const button = (id: string): HTMLButtonElement => element<HTMLButtonElement>(id);
let settings: SettingsView;
let api: RendererApi;
let lastSessionId: number;
let onDone: Parameters<RendererApi['onLlmDone']>[0];
let onDelta: Parameters<RendererApi['onLlmDelta']>[0];
let onError: Parameters<RendererApi['onSessionError']>[0];

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function ask(question: string): Promise<void> {
  element<HTMLInputElement>('askInput').value = question;
  element('askForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

function complete(answer: string): void {
  const calls = vi.mocked(api.askQuestion).mock.calls;
  onDone({
    sessionId: lastSessionId,
    transcript: calls[calls.length - 1][0],
    answer,
    metrics: { sttFinalizeMs: 0, firstTokenMs: 100, totalMs: 300 },
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  document.body.innerHTML = bodyHtml;
  settings = {
    resume: 'Existing resume', jobDescription: 'Existing job description',
    personalProfile: 'A Python developer learning systems design', customInstructions: 'Use practical examples.',
    alwaysOnTop: true, llmProvider: 'groq', anthropicModel: 'claude-haiku-4-5',
    groqModel: 'openai/gpt-oss-120b', audioSource: 'microphone', answerStyle: 'brief',
    hotkey: '', hotkeyRegistered: false, hasDeepgramKey: false, hasAnthropicKey: false, hasGroqKey: true,
  };
  lastSessionId = 0;
  api = {
    getSettings: vi.fn(async () => ({ ...settings })),
    saveSettings: vi.fn(async (patch: SettingsPatch) => {
      settings = { ...settings, ...patch };
      return { ...settings };
    }),
    askQuestion: vi.fn(async () => ({ ok: true as const, value: ++lastSessionId })),
    startSession: vi.fn(async () => ({ ok: true as const, value: ++lastSessionId })),
    sendAudio: vi.fn(), stopSession: vi.fn(async () => ({ ok: true as const, value: null })),
    cancelSession: vi.fn(async () => {}),
    onSttPartial: vi.fn(() => () => {}),
    onLlmDelta: vi.fn((callback) => { onDelta = callback; return () => {}; }),
    onLlmDone: vi.fn((callback) => { onDone = callback; return () => {}; }),
    onSessionError: vi.fn((callback) => { onError = callback; return () => {}; }),
    onHotkeyToggle: vi.fn(() => () => {}),
  };
  window.api = api;
  await import('../src/renderer/app');
  await flush();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('personalization settings', () => {
  test('offers typed questions when Groq is configured without a Deepgram key', async () => {
    expect(element('statusText').textContent).toContain('Ready — type a question');
    expect(button('askBtn').disabled).toBe(false);
    await ask('Explain a cache');
    expect(api.askQuestion).toHaveBeenLastCalledWith('Explain a cache', {});
  });

  test('loads, saves, and reopens profile and system instructions alongside existing settings', async () => {
    button('settingsBtn').click();
    await flush();
    const profile = element<HTMLTextAreaElement>('personalProfile');
    const instructions = element<HTMLTextAreaElement>('customInstructions');
    expect(profile.value).toBe(settings.personalProfile);
    expect(instructions.value).toBe(settings.customInstructions);
    expect(profile.maxLength).toBe(12000);
    expect(instructions.maxLength).toBe(8000);
    expect(button('styleBrief').getAttribute('aria-pressed')).toBe('true');

    profile.value = 'Engineering manager preparing for a leadership interview.';
    instructions.value = 'Lead with a direct answer. Use examples from healthcare.';
    button('saveBtn').click();
    await flush();
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      personalProfile: profile.value, customInstructions: instructions.value,
      resume: 'Existing resume', jobDescription: 'Existing job description',
      llmProvider: 'groq', answerStyle: 'brief',
    }));
    expect(vi.mocked(api.saveSettings).mock.calls[0][0]).not.toHaveProperty('groqKey');
    expect(element('savedNote').hidden).toBe(false);

    button('backBtn').click();
    profile.value = '';
    instructions.value = '';
    button('settingsBtn').click();
    await flush();
    expect(profile.value).toBe(settings.personalProfile);
    expect(instructions.value).toBe(settings.customInstructions);
  });

  test('supports clearing personalization and keeps unsaved text on a save error', async () => {
    button('settingsBtn').click();
    await flush();
    element<HTMLTextAreaElement>('personalProfile').value = '';
    element<HTMLTextAreaElement>('customInstructions').value = '';
    button('saveBtn').click();
    await flush();
    expect(settings.personalProfile).toBe('');
    expect(settings.customInstructions).toBe('');

    element<HTMLTextAreaElement>('customInstructions').value = 'Keep this unsaved instruction';
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error('Could not save settings'));
    button('saveBtn').click();
    await flush();
    expect(element('settingsError').hidden).toBe(false);
    expect(element('settingsError').textContent).toContain('Could not save settings');
    expect(element<HTMLTextAreaElement>('customInstructions').value).toBe('Keep this unsaved instruction');
  });
});

describe('contextual follow-ups', () => {
  test('requires a completed answer and uses a detailed override without changing saved style', async () => {
    expect(button('deeperBtn').disabled).toBe(true);
    expect(button('exampleBtn').disabled).toBe(true);
    expect(button('followupModeBtn').disabled).toBe(true);
    await ask('What is caching?');
    expect(api.askQuestion).toHaveBeenLastCalledWith('What is caching?', {});
    onDelta({ sessionId: lastSessionId, delta: 'Caching stores' });
    expect(button('deeperBtn').disabled).toBe(true);
    complete('Caching stores results for reuse.');
    expect(button('deeperBtn').disabled).toBe(false);

    button('deeperBtn').click();
    await flush();
    expect(api.askQuestion).toHaveBeenLastCalledWith(expect.stringContaining('Go deeper'), {
      context: [{ question: 'What is caching?', answer: 'Caching stores results for reuse.' }],
      answerStyle: 'detailed',
    });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(button('styleBrief').getAttribute('aria-pressed')).toBe('true');
    expect(button('deeperBtn').disabled).toBe(true);
    expect(button('exampleBtn').disabled).toBe(true);
    expect(button('followupModeBtn').disabled).toBe(true);
    expect(element<HTMLInputElement>('askInput').disabled).toBe(true);
    complete('Choose a TTL and an invalidation policy.');
    expect(button('followupModeBtn').getAttribute('aria-pressed')).toBe('true');
    expect(element<HTMLInputElement>('askInput').disabled).toBe(false);

    button('prevBtn').click();
    expect(element('answerBox').textContent).toBe('Caching stores results for reuse.');
    expect(element('historyLabel').textContent).toBe('1/2');
  });

  test('examples and typed follow-ups continue only the viewed branch', async () => {
    await ask('What is caching?');
    complete('Cache reusable results.');
    button('exampleBtn').click();
    await flush();
    expect(api.askQuestion).toHaveBeenLastCalledWith(expect.stringContaining('worked example'), {
      context: [{ question: 'What is caching?', answer: 'Cache reusable results.' }], answerStyle: 'detailed',
    });
    const exampleQuestion = vi.mocked(api.askQuestion).mock.calls[1][0];
    complete('Use a dictionary to cache results.');
    await ask('What about expiration?');
    expect(api.askQuestion).toHaveBeenLastCalledWith('What about expiration?', {
      context: [
        { question: 'What is caching?', answer: 'Cache reusable results.' },
        { question: exampleQuestion, answer: 'Use a dictionary to cache results.' },
      ],
    });
    complete('Expire stale values with a TTL.');
    button('prevBtn').click();
    button('prevBtn').click();
    await ask('Explain cache misses instead.');
    expect(api.askQuestion).toHaveBeenLastCalledWith('Explain cache misses instead.', {
      context: [{ question: 'What is caching?', answer: 'Cache reusable results.' }],
    });
  });

  test('new question resets context, including while a follow-up is streaming', async () => {
    await ask('What is caching?');
    complete('Cache reusable results.');
    button('followupModeBtn').click();
    expect(element('askModeHint').textContent).toContain('What is caching?');
    await ask('Explain cache invalidation.');
    expect(element<HTMLInputElement>('askInput').disabled).toBe(true);
    button('newQuestionBtn').click();
    expect(element<HTMLInputElement>('askInput').disabled).toBe(false);
    await ask('What is an API?');
    expect(api.askQuestion).toHaveBeenLastCalledWith('What is an API?', {});
    complete('An interface for software.');
    button('followupModeBtn').click();
    await ask('Show me a REST API.');
    expect(api.askQuestion).toHaveBeenLastCalledWith('Show me a REST API.', {
      context: [{ question: 'What is an API?', answer: 'An interface for software.' }],
    });
  });

  test('regeneration preserves the viewed context and temporary style override', async () => {
    await ask('What is caching?');
    complete('Cache reusable results.');
    button('deeperBtn').click();
    await flush();
    const followupCall = vi.mocked(api.askQuestion).mock.calls[1];
    complete('Longer caching explanation.');
    button('newQuestionBtn').click();
    await ask('Unrelated question');
    complete('An unrelated answer.');
    button('prevBtn').click();
    button('regenBtn').click();
    await flush();
    expect(vi.mocked(api.askQuestion).mock.calls[3]).toEqual(followupCall);
    complete('Alternative caching explanation.');
    button('prevBtn').click();
    button('prevBtn').click();
    expect(element('answerBox').textContent).toBe('Longer caching explanation.');
  });

  test('errored and interrupted partial answers never become follow-up context', async () => {
    await ask('A failed question');
    onDelta({ sessionId: lastSessionId, delta: 'An incomplete answer' });
    onError({ sessionId: lastSessionId, error: { code: 'llm_http', message: 'Provider unavailable' } });
    expect(element('answerBox').textContent).toBe('An incomplete answer');
    expect(button('deeperBtn').disabled).toBe(true);
    expect(button('exampleBtn').disabled).toBe(true);
    expect(button('followupModeBtn').disabled).toBe(true);

    await ask('An interrupted question');
    onDelta({ sessionId: lastSessionId, delta: 'Interrupted partial answer' });
    const staleId = lastSessionId;
    await ask('A successful question');
    complete('A complete answer');
    onDone({ sessionId: staleId, transcript: 'An interrupted question', answer: 'Late answer', metrics: { sttFinalizeMs: 0, firstTokenMs: 0, totalMs: 0 } });
    button('prevBtn').click();
    expect(element('answerBox').textContent).toBe('Interrupted partial answer');
    expect(button('deeperBtn').disabled).toBe(true);
    expect(button('followupModeBtn').disabled).toBe(true);
    button('nextBtn').click();
    button('exampleBtn').click();
    await flush();
    expect(api.askQuestion).toHaveBeenLastCalledWith(expect.any(String), {
      context: [{ question: 'A successful question', answer: 'A complete answer' }], answerStyle: 'detailed',
    });
  });

  test('bounds history and branch context, then clears the conversation mode', async () => {
    await ask('Question 0');
    complete('Answer 0');
    button('followupModeBtn').click();
    for (let i = 1; i <= 8; i += 1) {
      await ask(`Question ${i}`);
      complete(`Answer ${i}`);
    }
    const lastCall = vi.mocked(api.askQuestion).mock.calls.at(-1)!;
    expect(lastCall[1]?.context).toEqual([
      { question: 'Question 0', answer: 'Answer 0' },
      ...Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i + 3}`, answer: `Answer ${i + 3}` })),
    ]);
    expect(element('historyLabel').textContent).toBe('6/6');
    for (let i = 0; i < 5; i += 1) button('prevBtn').click();
    expect(element('transcriptBox').textContent).toBe('Question 3');
    expect(button('prevBtn').disabled).toBe(true);
    button('clearBtn').click();
    expect(element('historyBar').hidden).toBe(true);
    expect(button('newQuestionBtn').getAttribute('aria-pressed')).toBe('true');
    expect(button('followupModeBtn').disabled).toBe(true);
    expect(button('deeperBtn').disabled).toBe(true);
    await ask('Start over');
    expect(api.askQuestion).toHaveBeenLastCalledWith('Start over', {});
  });
});
