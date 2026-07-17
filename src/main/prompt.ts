import type { AnswerStyle } from '../shared/types';

// Builds the system prompt for the answer model from the user's saved profile.
// Pure functions (no store/electron dependency) so they can be unit-tested directly.
//
// The prompt is deliberately built as TWO pieces:
//
//   cachedPrefix — role instructions + resume + JD. Stable for the whole
//                  interview, and the only piece worth marking with
//                  cache_control (see llm/anthropic.ts).
//   styleSuffix  — the answer-length policy. Changes whenever the user flips
//                  the answerStyle setting.
//
// Prompt caching is a *prefix match*: any byte change invalidates everything
// after it. Folding the style policy into the cached block would mean toggling
// brief/balanced/detailed silently throws away the cached resume+JD and pays a
// full uncached prefill on the next answer — i.e. a slower first token, which
// is the one thing this app exists to avoid. Keeping it in its own trailing
// block means a style change costs nothing.

const ROLE_INSTRUCTIONS =
  'You are a real-time call assistant helping the user answer questions asked of them ' +
  'during a live interview or call. You are given a transcript of what the other person just said. ' +
  'Reply with the answer the user should say, written in first person, in natural spoken English. ' +
  'Do not add meta commentary, greetings, or quotation marks — output only the answer itself. ' +
  'If the transcript contains no real question, briefly suggest what the user could say next.';

// The length/shape policy per style. `balanced` keeps v1's wording verbatim, so
// the default behaviour is unchanged by the introduction of answerStyle.
const STYLE_INSTRUCTIONS: Record<AnswerStyle, string> = {
  brief:
    'Answer in one or two spoken sentences — the shortest reply that fully answers the question. ' +
    'No lists, no headings, no lead-in.',
  balanced:
    'Be concise and confident: a few sentences for simple questions, short structured points for ' +
    'complex ones.',
  detailed:
    'Give a structured answer: one sentence that answers directly, then three to five short ' +
    'supporting points (what the situation was, what you did, what the result was). Keep every ' +
    'point short enough to say in one breath — this is spoken aloud, not read.',
};

export interface SystemPromptBlocks {
  /** Stable for the session. Safe to mark with cache_control. */
  cachedPrefix: string;
  /** Varies with the answerStyle setting. Must sit AFTER the cache breakpoint. */
  styleSuffix: string;
}

/** The system prompt split at the cache breakpoint. Providers that support prompt caching should use this. */
export function buildSystemPromptBlocks(
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
): SystemPromptBlocks {
  const resumeText = (resume || '').trim();
  const jdText = (jd || '').trim();

  let cachedPrefix = ROLE_INSTRUCTIONS;
  if (resumeText) cachedPrefix += "\n\n--- THE USER'S RESUME ---\n" + resumeText;
  if (jdText) cachedPrefix += '\n\n--- THE JOB THEY ARE INTERVIEWING FOR ---\n' + jdText;
  if (resumeText || jdText) {
    cachedPrefix +=
      '\n\nGround every answer in the resume and target role above. ' +
      'Never invent experience the resume does not support.';
  }

  // Fall back to `balanced` rather than splicing `undefined` into the prompt if
  // a stale/unvalidated style ever reaches us from the settings store.
  const styleSuffix = STYLE_INSTRUCTIONS[answerStyle] ?? STYLE_INSTRUCTIONS.balanced;
  return { cachedPrefix, styleSuffix };
}

/** The whole system prompt as one string, for providers without prompt caching. */
export function buildSystemPrompt(resume: string, jd: string, answerStyle: AnswerStyle): string {
  const { cachedPrefix, styleSuffix } = buildSystemPromptBlocks(resume, jd, answerStyle);
  return cachedPrefix + '\n\n' + styleSuffix;
}

/** The user turn wrapped around the transcript. Kept out of the system prompt so the cached prefix stays stable. */
export function buildUserMessage(transcript: string): string {
  return 'The other person on the call just said:\n"""\n' + transcript + '\n"""\n\nWhat should I say?';
}
