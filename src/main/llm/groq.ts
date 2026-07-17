import type { AnswerStyle, AppError } from '../../shared/types';
import type { LlmProvider } from '../session';
import { buildSystemPrompt, buildUserMessage } from '../prompt';
import { parseSSEChunk, parseSSETail } from '../sse';

// Groq — the user-selectable "fastest" preset. OpenAI-compatible SSE
// streaming, parsed with the same battle-tested chunk parser v1 used for
// DeepSeek.
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Was `llama-3.3-70b-versatile`, which Groq announced as deprecated on
// 2026-06-17 with a hard shutdown on 2026-08-16 — it would have started
// returning errors within weeks. `openai/gpt-oss-120b` is Groq's own
// recommended replacement for it, is on the production model list, and runs at
// ~500 tok/s, which is what this preset is for.
const MODEL = 'openai/gpt-oss-120b';

// gpt-oss is a reasoning model, and reasoning is the enemy of time-to-first-word:
// left alone it thinks before it answers, and the user stares at an empty panel.
// `reasoning_effort: 'low'` keeps that to a minimum, and `include_reasoning:
// false` keeps the reasoning out of the response entirely. Note gpt-oss does NOT
// accept `reasoning_format` (that is the Qwen-family knob) — these two are the
// supported controls for this model family.
const REASONING_EFFORT = 'low';

export function createGroqProvider(
  apiKey: string,
  resume: string,
  jd: string,
  answerStyle: AnswerStyle,
): LlmProvider {
  const system = buildSystemPrompt(resume, jd, answerStyle);

  return {
    async generate(transcript, onDelta, signal) {
      let res: Response;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            stream: true,
            temperature: 0.7,
            reasoning_effort: REASONING_EFFORT,
            include_reasoning: false,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: buildUserMessage(transcript) },
            ],
          }),
        });
      } catch (err) {
        // fetch rejects with an AbortError when the session cancels us. That is
        // not a failure the user should ever see.
        if (signal.aborted) throw abortedError();
        throw {
          code: 'llm_http',
          message: 'Could not reach Groq. Check your internet connection.',
        } satisfies AppError;
      }

      if (!res.ok) {
        // Reading the body can itself fail on a dropped connection; an error
        // about the error is not worth crashing over.
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw httpError(res.status, body);
      }

      // 200 with no body: `res.body!.getReader()` used to throw a raw
      // "Cannot read properties of null" TypeError here, which surfaced to the
      // user as an `internal` error with a JavaScript message in it.
      if (!res.body) {
        throw { code: 'llm_http', message: 'Groq returned an empty response body.' } satisfies AppError;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      const emit = (delta: string): void => {
        full += delta;
        onDelta(delta);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { deltas, rest } = parseSSEChunk(buf);
          buf = rest;
          for (const delta of deltas) emit(delta);
        }
      } catch (err) {
        if (signal.aborted) throw abortedError();
        throw {
          code: 'llm_http',
          message: 'The connection to Groq dropped while the answer was streaming.',
        } satisfies AppError;
      }

      // Flush, in two steps, both of which drop characters if skipped:
      //   decoder.decode()  — emits any multi-byte UTF-8 sequence left half-decoded
      //                       by the final chunk (stream: true holds those back).
      //   parseSSETail(buf) — emits a final `data:` line that arrived without its
      //                       trailing newline, which parseSSEChunk cannot flush.
      buf += decoder.decode();
      for (const delta of parseSSETail(buf)) emit(delta);

      return full;
    },
  };
}

function abortedError(): AppError {
  return { code: 'aborted', message: 'Answer cancelled.' };
}

function httpError(status: number, body: string): AppError {
  if (status === 401 || status === 403) {
    return { code: 'llm_auth', message: 'Groq rejected the API key (401). Check it in Settings.' };
  }
  if (status === 429) {
    return {
      code: 'llm_rate_limit',
      message: 'Groq rate limit reached (429). Wait a few seconds and ask again, or check your plan limits.',
    };
  }
  if (status === 404) {
    // Most likely cause here is Groq retiring the pinned model out from under us.
    return {
      code: 'llm_http',
      message: `Groq does not recognise the model "${MODEL}" (404). It may have been retired — update MODEL in llm/groq.ts.`,
    };
  }
  if (status >= 500) {
    return { code: 'llm_http', message: `Groq is unavailable (HTTP ${status}). Try again in a moment.` };
  }
  return { code: 'llm_http', message: `Answer generation failed (HTTP ${status}): ${body}` };
}
