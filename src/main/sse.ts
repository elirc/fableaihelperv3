// Parser for OpenAI-style Server-Sent Events (the shape Groq streams).
//
// Network chunks do not align to line or event boundaries: a single `data:`
// line can be split across two reads, and one read can contain several lines.
// Feed each decoded chunk to parseSSEChunk together with whatever was left
// over from the last call; it returns the content deltas found in the
// *complete* lines and the trailing partial line to carry forward.
export function parseSSEChunk(buffer: string): { deltas: string[]; rest: string } {
  const deltas: string[] = [];
  // Scan by index instead of re-assigning `buffer = buffer.slice(...)` per
  // line: this runs for every network chunk of a streaming answer, and slicing
  // the whole remaining buffer once per line is O(lines x buffer) copying when
  // a chunk carries several events.
  let start = 0;
  let nl: number;
  while ((nl = buffer.indexOf('\n', start)) !== -1) {
    const line = buffer.slice(start, nl).trim(); // .trim() also drops the \r of CRLF
    start = nl + 1;
    if (!line.startsWith('data:')) continue; // skip comments/keep-alives/blank lines
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (delta) deltas.push(delta);
    } catch {
      // malformed/partial JSON — ignore this line rather than crash the stream
    }
  }
  return { deltas, rest: start === 0 ? buffer : buffer.slice(start) };
}

// End-of-stream flush for whatever parseSSEChunk handed back as `rest`.
//
// parseSSEChunk only ever emits deltas for newline-terminated lines, because
// until the newline arrives it cannot know the line is complete. That is
// correct mid-stream but drops data at the end: if the server closes after a
// final `data: {...}` without a trailing newline (a truncated or abruptly
// closed response), that last line sits in `rest` forever and its delta is
// silently lost — the user sees an answer missing its last few words with no
// error. Call this once after the read loop ends.
//
// Genuinely incomplete JSON still parses to nothing and is discarded, which is
// the right outcome: there is no more data coming to complete it.
export function parseSSETail(rest: string): string[] {
  if (!rest.trim()) return [];
  return parseSSEChunk(rest.endsWith('\n') ? rest : rest + '\n').deltas;
}
