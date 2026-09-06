import { describe, expect, test } from 'vitest';
import type { AnswerStyle, ConversationTurn } from '../src/shared/types';
import {
  buildConversationMessages, buildSystemPrompt, buildSystemPromptBlocks, buildUserMessage,
} from '../src/main/prompt';

const STYLES: AnswerStyle[] = ['brief', 'balanced', 'detailed'];
const PERSONALIZATION = {
  personalProfile: 'Career changer learning backend development; use payments examples.',
  customInstructions: 'Use plain English and explain unfamiliar terms.',
};

describe('buildSystemPrompt', () => {
  test('retains the interview coach role and standard rehearsal format', () => {
    const prompt = buildSystemPrompt('', '', 'balanced');
    expect(prompt).toMatch(/interview coach/i);
    expect(prompt).toMatch(/mock interview/i);
    expect(prompt).toMatch(/first person/i);
    expect(prompt).toMatch(/study material/i);
    expect(prompt).toContain('**Key beats**');
  });

  test('shapes answers by question type and requires technical accuracy', () => {
    const prompt = buildSystemPrompt('', '', 'balanced');
    expect(prompt).toContain('Behavioural');
    expect(prompt).toContain('Technical or knowledge');
    expect(prompt).toContain('Motivation');
    expect(prompt).toMatch(/technically correct/i);
  });

  test('omits empty and whitespace-only saved context sections', () => {
    const prompt = buildSystemPrompt(' \n ', '\t', 'brief', {
      personalProfile: '\n ', customInstructions: ' ',
    });
    expect(prompt).not.toContain('--- THE');
    expect(prompt).not.toContain('Ground every answer');
  });

  test('never invents personal experience even without a saved resume', () => {
    const prompt = buildSystemPrompt('', '', 'brief');
    expect(prompt).toMatch(/Never invent experience/i);
    expect(prompt).toMatch(/hypothetical example/i);
    expect(prompt).toMatch(/placeholders/i);
  });

  test('grounds answers when only the resume is set', () => {
    const prompt = buildSystemPrompt('Built payment systems', '', 'brief');
    expect(prompt).toContain("--- THE USER'S RESUME ---\nBuilt payment systems");
    expect(prompt).not.toContain('--- THE JOB THEY ARE INTERVIEWING FOR ---');
    expect(prompt).toContain('Ground every answer');
  });

  test('grounds answers when only the target role is set', () => {
    const prompt = buildSystemPrompt('', 'Senior Go Engineer', 'brief');
    expect(prompt).toContain('--- THE JOB THEY ARE INTERVIEWING FOR ---\nSenior Go Engineer');
    expect(prompt).not.toContain("--- THE USER'S RESUME ---");
    expect(prompt).toContain('Ground every answer');
  });

  test('grounds answers with a personal profile without requiring a resume or job description', () => {
    const prompt = buildSystemPrompt('', '', 'brief', { personalProfile: PERSONALIZATION.personalProfile });
    expect(prompt).toContain("--- THE USER'S PERSONAL PROFILE ---\n" + PERSONALIZATION.personalProfile);
    expect(prompt).toContain('Ground every answer');
    expect(prompt).not.toContain("--- THE USER'S RESUME ---");
  });

  test('keeps all saved context together and trims boundary whitespace', () => {
    const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(' resume text ', ' job text ', 'brief', {
      personalProfile: ' profile text ', customInstructions: ' instruction text ',
    });
    for (const text of ['resume text', 'job text', 'profile text', 'instruction text']) {
      expect(cachedPrefix).toContain('\n' + text);
      expect(cachedPrefix).not.toContain('\n ' + text);
      expect(styleSuffix).not.toContain(text);
    }
  });

  test('custom instructions override coaching defaults while preserving personal grounding', () => {
    const prompt = buildSystemPrompt('resume text', '', 'brief', PERSONALIZATION);
    expect(prompt).toContain(PERSONALIZATION.customInstructions);
    expect(prompt).toMatch(/override the default tone, role, answer length, or format/i);
    expect(prompt).toMatch(/including the Key beats format/i);
    expect(prompt).toMatch(/Retain relevant resume\/profile grounding/i);
    expect(prompt).toMatch(/never invent personal experience/i);
  });

  test.each(STYLES)('combined %s prompt is exactly the two caching blocks joined by a blank line', (style) => {
    const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks('r', 'j', style, PERSONALIZATION);
    expect(buildSystemPrompt('r', 'j', style, PERSONALIZATION)).toBe(cachedPrefix + '\n\n' + styleSuffix);
  });
});

describe('answerStyle and follow-up instructions', () => {
  test('brief starts with one or two spoken sentences and compact study notes', () => {
    const { styleSuffix } = buildSystemPromptBlocks('', '', 'brief');
    expect(styleSuffix).toMatch(/one or two spoken sentences/i);
    expect(styleSuffix).toMatch(/compact Key beats/i);
  });

  test('balanced and detailed lead directly, with different supporting depth', () => {
    expect(buildSystemPromptBlocks('', '', 'balanced').styleSuffix).toMatch(/concise direct answer/i);
    const detailed = buildSystemPromptBlocks('', '', 'detailed').styleSuffix;
    expect(detailed).toMatch(/one concise sentence/i);
    expect(detailed).toMatch(/three to five short supporting points/i);
  });

  test.each(STYLES)('%s permits substantive follow-ups and explicit depth requests', (style) => {
    const { styleSuffix } = buildSystemPromptBlocks('', '', style);
    expect(styleSuffix).toMatch(/explicit request for more detail, examples, code, tradeoffs, or a step-by-step/i);
    expect(styleSuffix).toMatch(/takes precedence over the default brevity limit/i);
    expect(styleSuffix).toMatch(/worked examples/i);
    expect(styleSuffix).toMatch(/avoid unnecessary repetition/i);
  });

  test('follow-up explanations can use a natural format without mandatory study notes', () => {
    const prompt = buildSystemPrompt('', '', 'brief');
    expect(prompt).toMatch(/not a new interview question/i);
    expect(prompt).toMatch(/A follow-up does not need a Key beats section/i);
  });

  test('styles remain distinct and live outside the stable cached prefix', () => {
    const blocks = STYLES.map(style => buildSystemPromptBlocks('resume', 'jd', style, PERSONALIZATION));
    expect(new Set(blocks.map(block => block.cachedPrefix)).size).toBe(1);
    expect(new Set(blocks.map(block => block.styleSuffix)).size).toBe(STYLES.length);
    for (const block of blocks) expect(block.cachedPrefix).not.toContain(block.styleSuffix);
  });

  test('the cached prefix is also identical across styles without saved context', () => {
    const prefixes = STYLES.map(style => buildSystemPromptBlocks('', '', style).cachedPrefix);
    expect(new Set(prefixes).size).toBe(1);
  });

  test('an unknown style falls back to concise-first without changing the cached prefix', () => {
    expect(buildSystemPromptBlocks('resume', 'jd', 'wat' as AnswerStyle, PERSONALIZATION)).toEqual(
      buildSystemPromptBlocks('resume', 'jd', 'brief', PERSONALIZATION),
    );
  });
});

describe('conversation messages', () => {
  test('retains the initial-question wrapper for backward compatibility', () => {
    expect(buildUserMessage('Why Go?')).toBe(
      'My practice partner just asked:\n"""\nWhy Go?\n"""\n\nWrite the model answer.',
    );
    expect(buildConversationMessages('Why Go?')).toEqual([
      { role: 'user', content: buildUserMessage('Why Go?') },
    ]);
    expect(buildConversationMessages('Why Go?', [])).toEqual(buildConversationMessages('Why Go?'));
  });

  test('preserves historical user and assistant turns in order', () => {
    const context: ConversationTurn[] = [
      { question: 'What are closures?', answer: 'Functions that retain access to their lexical scope.' },
      { question: 'Give me an example.', answer: 'A counter function can retain a private count.' },
    ];
    const messages = buildConversationMessages('Walk through the counter step by step.', context);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages[0].content).toBe(buildUserMessage(context[0].question));
    expect(messages[1].content).toBe(context[0].answer);
    expect(messages[2].content).toContain(context[1].question);
    expect(messages[2].content).toMatch(/follow-up request/i);
    expect(messages[3].content).toBe(context[1].answer);
    expect(messages[4].content).toContain('Walk through the counter step by step.');
    expect(messages[4].content).toMatch(/follow-up request/i);
    expect(messages[4].content).not.toContain('My practice partner just asked');
  });

  test('preserves quotes and newlines without mutating the supplied conversation', () => {
    const transcript = 'Line one.\nLine two with "quotes".';
    const context: ConversationTurn[] = [{ question: transcript, answer: 'Answer\nwith a second line.' }];
    const original = structuredClone(context);
    const messages = buildConversationMessages(transcript, context);
    expect(messages[0].content).toContain(transcript);
    expect(messages[1].content).toBe(context[0].answer);
    expect(messages[2].content).toContain(transcript);
    expect(context).toEqual(original);
  });
});
