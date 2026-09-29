import { describe, expect, test } from 'vitest';
import type { SettingsView } from '../src/shared/types';
import {
  boundRelatedAnswer, cloneContext, contextCharacters, CONTEXT_LIMITS, createDefaultProfile,
  createProfile, DEFAULT_OUTPUT, resolveContext,
} from '../src/shared/context';
import { answerOptionsSchema, contextProfilesSchema, contextSnapshotSchema } from '../src/main/context-schema';

function settings(patch: Partial<SettingsView> = {}): SettingsView {
  return {
    resume: 'My actual experience', jobDescription: 'The target role', answerStyle: 'balanced',
    alwaysOnTop: true, llmProvider: 'anthropic', hotkey: '', hotkeyRegistered: false,
    hasDeepgramKey: false, hasAnthropicKey: false, hasGroqKey: false, ...patch,
  };
}

describe('answer context resolution', () => {
  test('legacy settings resolve to an Interview profile with existing material and length', () => {
    const context = resolveContext(settings({ answerStyle: 'detailed' }));
    expect(context).toMatchObject({ profileId: 'interview', profileName: 'Interview',
      resume: 'My actual experience', jobDescription: 'The target role', output: { answerStyle: 'detailed' } });
    expect(contextSnapshotSchema.safeParse(context).success).toBe(true);
  });

  test('request preferences override scenario preferences which override defaults', () => {
    const profile = createProfile('technical', 'technical-1');
    profile.output = { tone: 'diplomatic', format: 'talking-points' };
    const context = resolveContext(settings({ contextProfiles: [profile], activeProfileId: profile.id,
      outputDefaults: { ...DEFAULT_OUTPUT, answerStyle: 'brief', tone: 'conversational', audience: 'technical' } }),
    { overrides: { tone: 'confident', answerStyle: 'detailed' } });
    expect(context.output).toEqual({ answerStyle: 'detailed', tone: 'confident',
      format: 'talking-points', audience: 'technical' });
  });

  test('disabled references are excluded rather than merely discouraged in instructions', () => {
    const profile = createProfile('client', 'client-1');
    profile.background = 'Confirmed product details';
    expect(resolveContext(settings({ contextProfiles: [profile] }))).toMatchObject({
      resume: '', jobDescription: '', background: 'Confirmed product details',
    });
  });

  test('a missing explicitly requested profile fails instead of silently using another scenario', () => {
    expect(() => resolveContext(settings(), { profileId: 'deleted-profile' })).toThrow(/no longer exists/);
  });

  test('request snapshot remains independent of settings and overrides', () => {
    const profile = createDefaultProfile();
    const overrides = { tone: 'diplomatic' as const };
    const s = settings({ contextProfiles: [profile] });
    const snapshot = resolveContext(s, { overrides, questionNote: 'Use the migration example' });
    profile.instructions = 'Later profile instruction';
    profile.output.answerStyle = 'detailed';
    s.resume = 'Different resume';
    overrides.tone = 'confident' as typeof overrides.tone;
    expect(snapshot.resume).toBe('My actual experience');
    expect(snapshot.instructions).not.toBe(profile.instructions);
    expect(snapshot.output).toMatchObject({ tone: 'diplomatic', answerStyle: 'balanced' });
    expect(snapshot.questionNote).toBe('Use the migration example');
  });

  test('original regeneration uses its snapshot after the profile is changed or deleted', () => {
    const snapshot = resolveContext(settings(), { questionNote: 'Original direction',
      followUp: { question: 'Prior question', answer: 'Unconfirmed prior suggestion' } });
    const regenerated = resolveContext(settings({ resume: 'New experience',
      contextProfiles: [createProfile('meeting', 'new')] }), { snapshot });
    expect(regenerated).toEqual(snapshot);
    regenerated.output.tone = 'diplomatic';
    regenerated.relatedAnswer!.answer = 'Mutation';
    expect(snapshot.output.tone).toBe('confident');
    expect(snapshot.relatedAnswer!.answer).toBe('Unconfirmed prior suggestion');
  });

  test('refinement overrides only requested fields and an explicit empty note clears the original note', () => {
    const snapshot = resolveContext(settings(), { questionNote: 'Old note' });
    const revised = resolveContext(settings(), { snapshot, overrides: { answerStyle: 'brief' },
      questionNote: '', refinement: 'Be more specific about the implementation.' });
    expect(revised).toMatchObject({ questionNote: '', refinement: 'Be more specific about the implementation.',
      output: { answerStyle: 'brief', format: 'spoken' } });
    expect(snapshot.questionNote).toBe('Old note');
  });

  test('follow-ups bound the selected excerpt without mutating the source', () => {
    const original = { question: 'q'.repeat(2000), answer: 'a'.repeat(6000) };
    const bounded = boundRelatedAnswer(original);
    expect(bounded.question).toHaveLength(CONTEXT_LIMITS.relatedQuestion);
    expect(bounded.answer).toHaveLength(CONTEXT_LIMITS.relatedAnswer);
    expect(original.answer).toHaveLength(6000);
    expect(resolveContext(settings(), { followUp: original }).relatedAnswer).toEqual(bounded);
  });

  test('templates and clones never share mutable output objects', () => {
    const first = createProfile('interview', 'first');
    const second = createProfile('interview', 'second');
    first.output.format = 'star';
    expect(second.output).toEqual({});
    const context = resolveContext(settings());
    cloneContext(context).output.audience = 'technical';
    expect(context.output.audience).toBe('general');
  });

  test('personalization and explicit conversation are captured without sharing later mutations', () => {
    const s = settings({ personalProfile: 'Backend developer', customInstructions: 'Use Python examples' });
    const context = [{ question: 'What is caching?', answer: 'Reuse a previous result.' }];
    const snapshot = resolveContext(s, { context, answerStyle: 'detailed' });
    s.personalProfile = 'Changed later';
    s.customInstructions = 'Different language';
    context[0].answer = 'Changed later';
    expect(snapshot).toMatchObject({ personalProfile: 'Backend developer',
      customInstructions: 'Use Python examples', output: { answerStyle: 'detailed' },
      conversation: [{ question: 'What is caching?', answer: 'Reuse a previous result.' }] });
    const regenerated = resolveContext(s, { snapshot });
    expect(regenerated).toEqual(snapshot);
    regenerated.conversation![0].answer = 'Changed copy';
    expect(snapshot.conversation![0].answer).toBe('Reuse a previous result.');
    expect(resolveContext(s).conversation).toBeUndefined();
  });

  test('explicit output override takes precedence over the compatible answerStyle option', () => {
    expect(resolveContext(settings(), { answerStyle: 'detailed', overrides: { answerStyle: 'brief' } })
      .output.answerStyle).toBe('brief');
  });
});

describe('context boundary validation', () => {
  test('oversized notes and unexpected privileged fields are rejected at IPC', () => {
    expect(answerOptionsSchema.safeParse({ questionNote: 'x'.repeat(CONTEXT_LIMITS.questionNote + 1) }).success).toBe(false);
    expect(answerOptionsSchema.safeParse({ apiKey: 'not-a-setting' }).success).toBe(false);
    expect(contextSnapshotSchema.safeParse({ ...resolveContext(settings()), secret: 'never allowed' }).success).toBe(false);
  });

  test('empty and duplicate profile lists are rejected', () => {
    expect(contextProfilesSchema.safeParse([]).success).toBe(false);
    expect(contextProfilesSchema.safeParse([createDefaultProfile(), createDefaultProfile()]).success).toBe(false);
  });

  test('valid legacy reference limits remain accepted and new context fields are bounded', () => {
    const snapshot = resolveContext(settings({ resume: 'r'.repeat(200_000), jobDescription: 'j'.repeat(200_000) }));
    expect(contextSnapshotSchema.safeParse(snapshot).success).toBe(true);
    snapshot.background = 'b'.repeat(CONTEXT_LIMITS.background + 1);
    expect(contextSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  test('conversation and personalization enforce individual and combined request budgets', () => {
    const turn = { question: 'q'.repeat(CONTEXT_LIMITS.conversationQuestion),
      answer: 'a'.repeat(CONTEXT_LIMITS.conversationAnswer) };
    expect(answerOptionsSchema.safeParse({ context: [turn] }).success).toBe(true);
    expect(answerOptionsSchema.safeParse({ context: Array(7).fill(turn) }).success).toBe(false);
    expect(answerOptionsSchema.safeParse({ context: [{ ...turn, answer: turn.answer + 'a' }] }).success).toBe(false);
    const context = resolveContext(settings({ resume: 'r'.repeat(200_000), jobDescription: 'j'.repeat(200_000),
      personalProfile: 'p'.repeat(CONTEXT_LIMITS.personalProfile),
      customInstructions: 'i'.repeat(CONTEXT_LIMITS.customInstructions) }));
    expect(contextSnapshotSchema.safeParse(context).success).toBe(true);
    context.conversation = [turn];
    expect(contextCharacters(context)).toBeGreaterThan(CONTEXT_LIMITS.total);
    expect(contextSnapshotSchema.safeParse(context).success).toBe(false);
    delete context.conversation;
    context.personalProfile += 'p';
    expect(contextSnapshotSchema.safeParse(context).success).toBe(false);
  });
});
