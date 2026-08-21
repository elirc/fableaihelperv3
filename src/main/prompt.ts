import type { AnswerStyle } from '../shared/types';

// Builds the system prompt for the answer model from the user's saved profile.
// Pure functions (no store/electron dependency) so they can be unit-tested directly.
//
// This app is a MOCK INTERVIEW PRACTICE tool: a practice partner asks the user
// a question out loud, and the model writes the answer a strong candidate would
// give, for the user to study and rehearse against. That framing is not
// cosmetic — it is why the output carries a "Key beats" section (study material
// is meant to be learned, not read out), and why answers are shaped by question
// type rather than forced into one behavioural mould.
//
// The prompt is deliberately built as TWO pieces:
//
//   cachedPrefix — role instructions + resume + JD. Stable for the whole
//                  practice session, and the only piece worth marking with
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
  'You are an interview coach running a mock interview practice session. The user is ' +
  'rehearsing out loud with a practice partner who asks them questions. You are given a ' +
  'transcript of the question that was just asked. Write the model answer the user should ' +
  'be aiming for — the answer a strong, well-prepared candidate would give — in first ' +
  'person, in natural spoken English. This is study material, not a live script: the user ' +
  'reads it, learns the shape, and then practises saying it in their own words.\n\n' +
  'Shape the answer to the kind of question it is:\n' +
  '- Behavioural ("tell me about a time..."): what the situation was, what you personally ' +
  'did, and how it turned out. Concrete and specific, with a real outcome.\n' +
  '- Technical or knowledge ("what are React hooks?"): lead with a one-sentence definition, ' +
  'then how it actually works, then a short concrete example. Be technically correct — a ' +
  'wrong answer is far worse practice than a short one.\n' +
  '- Motivation ("why this role?"): tie it to specifics of the job description rather than ' +
  'generic enthusiasm.\n\n' +
  'Write the answer itself first: first person, spoken English, no meta commentary, no ' +
  'greetings, no quotation marks around it. Do not include internal or system XML tags in ' +
  'your response. Then end with a section headed exactly ' +
  '"**Key beats**" holding two to four short bullets naming the points the answer has to ' +
  'hit. The bullets are what the user should memorise; the prose is what good sounds like. ' +
  'The style rule below governs the spoken answer only — the Key beats section is always ' +
  'present. If the transcript contains no real question, say so in one line and suggest ' +
  'what the partner could ask next.';

// The length/shape policy per style. `balanced` keeps v1's wording verbatim, so
// the default behaviour is unchanged by the introduction of answerStyle.
const STYLE_INSTRUCTIONS: Record<AnswerStyle, string> = {
  brief:
    'Answer in one or two spoken sentences — the shortest reply that fully answers the question. ' +
    'In the answer itself: no lists, no headings, no lead-in.',
  balanced:
    'Be concise and confident: a few sentences for simple questions, short structured points for ' +
    'complex ones.',
  detailed:
    'Give a structured answer: one sentence that answers directly, then three to five short ' +
    'supporting points — for a behavioural question, what the situation was, what you did and ' +
    'what the result was; for a technical one, how it works, when you would reach for it, and ' +
    'the tradeoff or gotcha that shows real depth. Keep every point short enough to say in one ' +
    'breath — this is spoken aloud, not read.',
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
      'Never invent experience the resume does not support — an answer built on a project ' +
      'the user cannot talk about in the real interview is worse than useless. ' +
      'For a general knowledge question, answer it on its own merits and use the resume ' +
      'only to pick the examples.';
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
  return (
    'My practice partner just asked:\n"""\n' + transcript + '\n"""\n\nWrite the model answer.'
  );
}
