import { describe, expect, test } from 'vitest';
import type { AnswerStyle } from '../src/shared/types';
import { buildSystemPrompt, buildSystemPromptBlocks, buildUserMessage } from '../src/main/prompt';

const STYLES: AnswerStyle[] = ['brief', 'balanced', 'detailed'];

describe('buildSystemPrompt', () => {
  test('always states the assistant role and first-person instruction', () => {
    const p = buildSystemPrompt('', '', 'balanced');
    expect(p).toMatch(/real-time call assistant/i);
    expect(p).toMatch(/first person/i);
  });

  test('omits resume/JD sections and grounding clause when profile is empty', () => {
    const p = buildSystemPrompt('', '', 'balanced');
    expect(p).not.toContain('RESUME');
    expect(p).not.toContain('JOB THEY ARE INTERVIEWING FOR');
    expect(p).not.toMatch(/Ground every answer/);
  });

  test('embeds the resume when provided', () => {
    const p = buildSystemPrompt('10 years building payments systems', '', 'balanced');
    expect(p).toMatch(/--- THE USER'S RESUME ---/);
    expect(p).toMatch(/payments systems/);
    expect(p).toMatch(/Ground every answer/);
  });

  test('embeds the job description when provided', () => {
    const p = buildSystemPrompt('', 'Senior Backend Engineer, Go and Postgres', 'balanced');
    expect(p).toMatch(/--- THE JOB THEY ARE INTERVIEWING FOR ---/);
    expect(p).toMatch(/Senior Backend Engineer/);
  });

  test('includes both sections and the grounding clause when both are set', () => {
    const p = buildSystemPrompt('resume text', 'job text', 'balanced');
    expect(p).toMatch(/resume text/);
    expect(p).toMatch(/job text/);
    expect(p).toMatch(/Never invent experience/);
  });

  test('trims whitespace-only input so it counts as empty', () => {
    const p = buildSystemPrompt('   \n  ', '\t', 'balanced');
    expect(p).not.toContain('RESUME');
    expect(p).not.toMatch(/Ground every answer/);
  });

  test('is the cached prefix followed by the style suffix', () => {
    const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks('r', 'j', 'detailed');
    const whole = buildSystemPrompt('r', 'j', 'detailed');
    expect(whole.startsWith(cachedPrefix)).toBe(true);
    expect(whole.endsWith(styleSuffix)).toBe(true);
  });

  // Exact concatenation, not just startsWith/endsWith: an extra character
  // between the blocks would make the single-string prompt (Groq) diverge from
  // the two-block prompt (Anthropic) and the styles would drift apart per provider.
  test('is exactly cachedPrefix + blank line + styleSuffix for every style', () => {
    for (const style of STYLES) {
      const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks('r', 'j', style);
      expect(buildSystemPrompt('r', 'j', style)).toBe(cachedPrefix + '\n\n' + styleSuffix);
    }
  });

  test('resume-only profile omits the JD section but keeps the grounding clause', () => {
    const { cachedPrefix } = buildSystemPromptBlocks('payments systems', '', 'balanced');
    expect(cachedPrefix).toContain("--- THE USER'S RESUME ---");
    expect(cachedPrefix).not.toContain('--- THE JOB THEY ARE INTERVIEWING FOR ---');
    expect(cachedPrefix).toMatch(/Ground every answer/);
  });

  test('JD-only profile omits the resume section but keeps the grounding clause', () => {
    const { cachedPrefix } = buildSystemPromptBlocks('', 'Senior Backend Engineer', 'balanced');
    expect(cachedPrefix).not.toContain("--- THE USER'S RESUME ---");
    expect(cachedPrefix).toContain('--- THE JOB THEY ARE INTERVIEWING FOR ---');
    expect(cachedPrefix).toMatch(/Ground every answer/);
  });
});

describe('answerStyle', () => {
  test('balanced keeps v1 wording, so the default behaviour is unchanged', () => {
    expect(buildSystemPrompt('', '', 'balanced')).toMatch(
      /Be concise and confident: a few sentences for simple questions, short structured points for complex ones\./,
    );
  });

  test('brief asks for one or two spoken sentences', () => {
    const p = buildSystemPrompt('', '', 'brief');
    expect(p).toMatch(/one or two spoken sentences/i);
    expect(p).not.toMatch(/Be concise and confident/);
  });

  test('detailed asks for structured supporting points', () => {
    const p = buildSystemPrompt('', '', 'detailed');
    expect(p).toMatch(/structured/i);
    expect(p).toMatch(/supporting points/i);
    expect(p).not.toMatch(/Be concise and confident/);
  });

  test('every style produces a distinct, non-empty instruction', () => {
    const suffixes = STYLES.map((s) => buildSystemPromptBlocks('', '', s).styleSuffix);
    for (const s of suffixes) expect(s.length).toBeGreaterThan(0);
    expect(new Set(suffixes).size).toBe(STYLES.length);
  });

  test('an unknown style falls back to balanced instead of splicing in undefined', () => {
    const p = buildSystemPrompt('', '', 'wat' as AnswerStyle);
    expect(p).not.toMatch(/undefined/);
    expect(p).toMatch(/Be concise and confident/);
  });

  // The caching invariant. Prompt caching is a prefix match, so if the style
  // policy lived inside the cached block, flipping this setting would throw away
  // the cached resume+JD and cost a full uncached prefill (i.e. a slow first
  // token) on the next answer.
  test('changing the style does not change the cached prefix', () => {
    const prefixes = STYLES.map((s) => buildSystemPromptBlocks('resume', 'jd', s).cachedPrefix);
    expect(new Set(prefixes).size).toBe(1);
  });

  test('the cached prefix is byte-identical across styles for an empty profile too', () => {
    const prefixes = STYLES.map((s) => buildSystemPromptBlocks('', '', s).cachedPrefix);
    expect(new Set(prefixes).size).toBe(1);
  });

  test('an unknown style still leaves the cached prefix untouched', () => {
    // The fallback must live entirely in the suffix: if it ever leaked into the
    // prefix, a corrupt settings file would silently invalidate the cache.
    const good = buildSystemPromptBlocks('resume', 'jd', 'balanced');
    const bad = buildSystemPromptBlocks('resume', 'jd', 'wat' as AnswerStyle);
    expect(bad.cachedPrefix).toBe(good.cachedPrefix);
    expect(bad.styleSuffix).toBe(good.styleSuffix);
  });

  test('the style instruction is not duplicated into the cached prefix', () => {
    const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks('resume', 'jd', 'brief');
    expect(cachedPrefix).not.toContain(styleSuffix);
  });

  test('the resume and JD stay in the cached prefix, not the style suffix', () => {
    const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks('payments systems', 'Go and Postgres', 'brief');
    expect(cachedPrefix).toContain('payments systems');
    expect(cachedPrefix).toContain('Go and Postgres');
    expect(styleSuffix).not.toContain('payments systems');
    expect(styleSuffix).not.toContain('Go and Postgres');
  });
});

describe('buildUserMessage', () => {
  test('wraps the transcript and asks what to say', () => {
    const m = buildUserMessage('Tell me about yourself.');
    expect(m).toContain('Tell me about yourself.');
    expect(m).toMatch(/What should I say\?/);
  });

  // Pinned exactly: the user turn is part of every request, and any accidental
  // wording drift here would change token counts and model behaviour silently.
  test('produces the exact wrapping format', () => {
    expect(buildUserMessage('Why Go?')).toBe(
      'The other person on the call just said:\n"""\nWhy Go?\n"""\n\nWhat should I say?',
    );
  });

  test('passes the transcript through verbatim, including newlines and quotes', () => {
    const transcript = 'Line one.\nLine two with "quotes".';
    expect(buildUserMessage(transcript)).toContain(transcript);
  });

  test('does not carry the answer style, so the user turn stays cache-neutral', () => {
    expect(buildUserMessage('hi')).not.toMatch(/sentence|structured|concise/i);
  });
});
