import type { AnswerStyle, ConversationTurn } from '../shared/types';

// Pure prompt builders shared by every provider. Saved context stays in the
// cached prefix; changing answer length only changes the trailing style block.

export interface PromptPersonalization {
  personalProfile?: string;
  customInstructions?: string;
}

const ROLE_INSTRUCTIONS =
  'You are an interview coach running a mock interview practice session. The user is ' +
  'rehearsing with a practice partner. For a new interview question, write a model answer ' +
  'the user can study and rehearse: first person, natural spoken English, with the direct ' +
  'answer first. This is study material. Do not add greetings, meta commentary, quotation ' +
  'marks around the answer, or internal/system XML tags.\n\n' +
  'Shape the answer to the kind of question it is:\n' +
  '- Behavioural ("tell me about a time..."): explain the situation, the user\'s own actions, ' +
  'and the outcome, using only supported personal details.\n' +
  '- Technical or knowledge ("what are React hooks?"): lead with a clear definition, ' +
  'then explain how it works and include a compact example when helpful. Be technically correct.\n' +
  '- Motivation ("why this role?"): connect the user\'s background and goals to specifics ' +
  'of the target role, where available.\n\n' +
  'For standard interview answers, end with "**Key beats**" and two to four short bullets ' +
  'the user can remember. Keep these compact even when the answer is brief. If the latest ' +
  'message is a follow-up request, answer that request in the context of the previous ' +
  'question and answer; it is not a new interview question. Coaching, explanations, code, ' +
  'and examples can use their natural format instead of forcing everything into a ' +
  'first-person interview answer. A follow-up does not need a Key beats section. ' +
  'If a new transcript contains no real question or request, say so in one line and ' +
  'suggest what the partner could ask next.\n\n' +
  'Never invent experience, qualifications, employers, project details, or results for ' +
  'the user. Use the resume and personal profile as the source of personal facts; the ' +
  'job description describes the target role, not the user\'s experience. If a personal ' +
  'example needs facts that are missing, use a clearly labeled hypothetical example or ' +
  'a short template with placeholders, or ask for the essential missing detail. Never ' +
  'present a hypothetical example as something the user actually did.';

const STYLE_INSTRUCTIONS: Record<AnswerStyle, string> = {
  brief:
    'Keep the initial answer concise: one or two spoken sentences that answer the question ' +
    'directly, followed by compact Key beats. Avoid extra headings and lists in the spoken answer.',
  balanced:
    'Lead with a concise direct answer. Use a few sentences for simple questions and short ' +
    'structured points for complex ones, followed by compact Key beats.',
  detailed:
    'Lead with one concise sentence that answers directly, then give three to five short ' +
    'supporting points. Include the relevant reasoning, example, or tradeoff, followed by compact Key beats.',
};

const FOLLOW_UP_INSTRUCTIONS =
  'These length and format rules are defaults, subject to the user\'s saved custom instructions. ' +
  'An explicit request for more detail, examples, code, tradeoffs, or a step-by-step ' +
  'explanation takes precedence over the default brevity limit, including in brief mode. ' +
  'Give the requested substance immediately; do not merely offer to explain or repeat ' +
  'the previous answer. Use specific worked examples and enough detail to make them useful. ' +
  'Continue from the conversation context, refer back only where needed, and avoid ' +
  'unnecessary repetition. Do not append a generic "would you like more detail?" offer.';

export interface SystemPromptBlocks {
  /** Stable while the saved context is unchanged. Safe to mark with cache_control. */
  cachedPrefix: string;
  /** Varies with answerStyle and must sit AFTER the cache breakpoint. */
  styleSuffix: string;
}

/** The system prompt split at the cache breakpoint, for providers with prompt caching. */
export function buildSystemPromptBlocks(
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
  personalization: PromptPersonalization = {},
): SystemPromptBlocks {
  const resumeText = (resume || '').trim();
  const jdText = (jd || '').trim();
  const profileText = (personalization.personalProfile || '').trim();
  const customInstructions = (personalization.customInstructions || '').trim();

  let cachedPrefix = ROLE_INSTRUCTIONS;
  if (resumeText) cachedPrefix += "\n\n--- THE USER'S RESUME ---\n" + resumeText;
  if (jdText) cachedPrefix += '\n\n--- THE JOB THEY ARE INTERVIEWING FOR ---\n' + jdText;
  if (profileText) cachedPrefix += "\n\n--- THE USER'S PERSONAL PROFILE ---\n" + profileText;
  if (resumeText || jdText || profileText) {
    cachedPrefix +=
      '\n\nGround every answer in the relevant background, personal profile, and target ' +
      'role above. Tailor the examples, level of explanation, and emphasis to the user\'s ' +
      'goals and experience. For a general knowledge question, answer on its own merits ' +
      'and use this context to choose useful examples without forcing unrelated details in.';
  }
  if (customInstructions) {
    cachedPrefix +=
      '\n\n--- THE USER\'S CUSTOM SYSTEM INSTRUCTIONS ---\n' + customInstructions +
      '\n\nApply these saved instructions to personalize your responses. They supplement ' +
      'the default coaching instructions and override the default tone, role, answer ' +
      'length, or format where they conflict (including the Key beats format). Retain ' +
      'relevant resume/profile grounding and never invent personal experience.';
  }

  // Invalid or stale values should retain the concise-first default.
  const styleSuffix = (STYLE_INSTRUCTIONS[answerStyle] ?? STYLE_INSTRUCTIONS.brief) +
    '\n\n' + FOLLOW_UP_INSTRUCTIONS;
  return { cachedPrefix, styleSuffix };
}

/** The whole system prompt as one string, for providers without prompt caching. */
export function buildSystemPrompt(
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
  personalization: PromptPersonalization = {},
): string {
  const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(resume, jd, answerStyle, personalization);
  return cachedPrefix + '\n\n' + styleSuffix;
}

/** Keep the original initial-question wrapper compatible with existing provider callers. */
export function buildUserMessage(transcript: string): string {
  return (
    'My practice partner just asked:\n"""\n' + transcript + '\n"""\n\nWrite the model answer.'
  );
}

function buildFollowUpMessage(request: string): string {
  return 'My follow-up request about the conversation above:\n"""\n' + request +
    '\n"""\n\nAnswer this follow-up directly using the previous question and answer as context.';
}

/** Preserve real conversation roles so "give an example" can refer to the last answer. */
export function buildConversationMessages(
  transcript: string,
  context: ConversationTurn[] = [],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const [index, turn] of context.entries()) {
    messages.push({
      role: 'user',
      content: index === 0 ? buildUserMessage(turn.question) : buildFollowUpMessage(turn.question),
    });
    messages.push({ role: 'assistant', content: turn.answer });
  }
  messages.push({
    role: 'user',
    content: context.length ? buildFollowUpMessage(transcript) : buildUserMessage(transcript),
  });
  return messages;
}
