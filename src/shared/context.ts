import type {
  AnswerOptions, AnswerStyle, ContextSnapshot, OutputPreferences,
  RelatedAnswer, ScenarioProfile, SettingsView, Situation,
} from './types';

/** Character budgets, enforced again at the main-process boundary. */
export const CONTEXT_LIMITS = {
  profiles: 20,
  id: 100,
  name: 80,
  background: 16_000,
  instructions: 8_000,
  questionNote: 2_000,
  refinement: 1_000,
  resume: 200_000,
  jobDescription: 200_000,
  personalProfile: 12_000,
  customInstructions: 8_000,
  conversationTurns: 6,
  conversationQuestion: 20_000,
  conversationAnswer: 20_000,
  relatedQuestion: 1_000,
  relatedAnswer: 3_000,
  total: 435_000,
} as const;

export const DEFAULT_OUTPUT: Readonly<OutputPreferences> = Object.freeze({
  answerStyle: 'balanced', format: 'spoken', tone: 'confident', audience: 'general',
});

export const SITUATION_LABELS: Record<Situation, string> = {
  interview: 'Interview', technical: 'Technical discussion', client: 'Client call',
  meeting: 'Meeting', custom: 'Custom',
};

const TEMPLATE_INSTRUCTIONS: Record<Situation, string> = {
  interview: 'Help me answer interview questions using examples supported by my background. Never invent experience or results.',
  technical: 'Explain the approach and important trade-offs. Ask a clarifying question only when an essential detail is missing. Distinguish experience from how I would approach a problem.',
  client: 'Respond to the client with relevant facts and practical next steps. Do not invent pricing, features, commitments, or delivery dates.',
  meeting: 'Help me give clear updates, explain decisions, and suggest practical next steps. Distinguish proposals from agreed commitments.',
  custom: '',
};

/** Templates are copied so future template changes cannot rewrite saved instructions. */
export function createProfile(
  situation: Situation,
  id: string = globalThis.crypto.randomUUID(),
  name = SITUATION_LABELS[situation],
): ScenarioProfile {
  return {
    id, name, situation, background: '', instructions: TEMPLATE_INSTRUCTIONS[situation],
    includeResume: situation === 'interview' || situation === 'technical',
    includeJobDescription: situation === 'interview', output: {},
  };
}

export function createDefaultProfile(answerStyle: AnswerStyle = 'balanced'): ScenarioProfile {
  return { ...createProfile('interview', 'interview', 'Interview'), output: { answerStyle } };
}

export function cloneContext(context: ContextSnapshot): ContextSnapshot {
  return {
    ...context, output: { ...context.output },
    ...(context.relatedAnswer ? { relatedAnswer: { ...context.relatedAnswer } } : {}),
    ...(context.conversation ? { conversation: context.conversation.map((turn) => ({ ...turn })) } : {}),
  };
}

/** Follow-ups use bounded excerpts from exactly the selected entry. */
export function boundRelatedAnswer(related: RelatedAnswer): RelatedAnswer {
  return {
    question: related.question.slice(0, CONTEXT_LIMITS.relatedQuestion),
    answer: related.answer.slice(0, CONTEXT_LIMITS.relatedAnswer),
  };
}

export function contextCharacters(context: ContextSnapshot): number {
  return context.background.length + context.instructions.length + context.resume.length +
    context.jobDescription.length + context.questionNote.length + (context.refinement?.length ?? 0) +
    (context.relatedAnswer?.question.length ?? 0) + (context.relatedAnswer?.answer.length ?? 0) +
    (context.personalProfile?.length ?? 0) + (context.customInstructions?.length ?? 0) +
    (context.conversation?.reduce((total, turn) => total + turn.question.length + turn.answer.length, 0) ?? 0);
}

/** Request overrides win over a scenario, which wins over global defaults. */
export function resolveContext(settings: SettingsView, options: AnswerOptions = {}): ContextSnapshot {
  let context: ContextSnapshot;
  if (options.snapshot) {
    context = cloneContext(options.snapshot);
  } else {
    const profiles = settings.contextProfiles?.length
      ? settings.contextProfiles : [createDefaultProfile(settings.answerStyle)];
    const requestedId = options.profileId ?? settings.activeProfileId;
    const profile = profiles.find((p) => p.id === requestedId) ?? (options.profileId ? undefined : profiles[0]);
    if (!profile) throw new Error('That context profile no longer exists. Choose another profile.');
    context = {
      profileId: profile.id, profileName: profile.name, situation: profile.situation,
      background: profile.background, instructions: profile.instructions,
      resume: profile.includeResume ? settings.resume : '',
      jobDescription: profile.includeJobDescription ? settings.jobDescription : '',
      personalProfile: settings.personalProfile ?? '',
      customInstructions: settings.customInstructions ?? '',
      output: { ...DEFAULT_OUTPUT, answerStyle: settings.answerStyle, ...settings.outputDefaults, ...profile.output },
      questionNote: '',
    };
  }
  context.output = { ...context.output,
    ...(options.answerStyle ? { answerStyle: options.answerStyle } : {}), ...options.overrides };
  if (options.context !== undefined) context.conversation = options.context.map((turn) => ({ ...turn }));
  if (options.questionNote !== undefined) context.questionNote = options.questionNote;
  if (options.followUp !== undefined) context.relatedAnswer = boundRelatedAnswer(options.followUp);
  if (options.refinement !== undefined) context.refinement = options.refinement;
  return context;
}
