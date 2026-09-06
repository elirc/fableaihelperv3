// Parser for OpenAI-style Server-Sent Events (the shape Groq streams).
//
// Network chunks do not align to line or event boundaries: a single `data:`
// line can be split across two reads, and one read can contain several lines.
// Feed each decoded chunk to parseSSEChunk together with whatever was left
// over from the last call; it returns the content deltas found in the
// *complete* lines and the trailing partial line to carry forward.

/** Token accounting as OpenAI-compatible streams report it (final chunk, or Groq's x_groq envelope). */
export interface SseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface SseError {
  message?: string;
  code?: string | number;
  type?: string;
}

export interface SseParseResult {
  deltas: string[];
  rest: string;
  /** Present only when a parsed line carried a usage object; the last one seen wins. */
  usage?: SseUsage;
  /** Errors can arrive after HTTP 200, inside the event stream. */
  error?: SseError;
  done?: true;
}

export function parseSSEChunk(buffer: string): SseParseResult {
  const deltas: string[] = [];
  let usage: SseUsage | undefined;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim(); // .trim() also drops the \r of CRLF
    buffer = buffer.slice(nl + 1);
    if (!line.startsWith('data:')) continue; // skip comments/keep-alives/blank lines
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      return { deltas, rest: '', ...(usage ? { usage } : {}), done: true };
    }
    try {
      const obj = JSON.parse(payload);
      if (obj?.error) {
        const error: SseError = typeof obj.error === 'string'
          ? { message: obj.error }
          : typeof obj.error === 'object' ? obj.error : {};
        return { deltas, rest: '', ...(usage ? { usage } : {}), error };
      }
      const delta = obj?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) deltas.push(delta);
      // Usage arrives on the final chunk when the request asked for it
      // (stream_options.include_usage); Groq also mirrors it under x_groq.
      const u = obj?.usage ?? obj?.x_groq?.usage;
      if (u && typeof u === 'object') usage = u as SseUsage;
    } catch {
      // malformed/partial JSON — ignore this line rather than crash the stream
    }
  }
  // Conditional so callers comparing the whole result don't see a usage key
  // on streams that never reported one.
  return usage ? { deltas, rest: buffer, usage } : { deltas, rest: buffer };
}

// End-of-stream flush for whatever parseSSEChunk handed back as `rest`.
//
// parseSSEChunk only ever emits deltas for newline-terminated lines, because
// until the newline arrives it cannot know the line is complete. That is
// correct mid-stream but drops data at the end: if the server closes after a
// final `data: {...}` without a trailing newline (a truncated or abruptly
// closed response), that last line sits in `rest` forever and its delta is
// silently lost — the user sees an answer missing its last few words with no
// error. Call this once after the read loop ends. The usage object rides the
// same final line on some servers, so it is surfaced here too.
//
// Genuinely incomplete JSON still parses to nothing and is discarded, which is
// the right outcome: there is no more data coming to complete it.
export function parseSSETail(rest: string): Omit<SseParseResult, 'rest'> {
  if (!rest.trim()) return { deltas: [] };
  const { rest: _rest, ...result } = parseSSEChunk(rest.endsWith('\n') ? rest : rest + '\n');
  return result;
}
