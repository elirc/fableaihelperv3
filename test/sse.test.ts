import { describe, expect, test } from 'vitest';
import { parseSSEChunk, parseSSETail } from '../src/main/sse';

function dataLine(content: string): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n';
}

/** Feed a whole stream body through the parser the way groq.ts does, including the end-of-stream flush. */
function drain(body: string, chunkSize = body.length): string[] {
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < body.length; i += chunkSize) {
    buf += body.slice(i, i + chunkSize);
    const { deltas, rest } = parseSSEChunk(buf);
    buf = rest;
    out.push(...deltas);
  }
  out.push(...parseSSETail(buf).deltas);
  return out;
}

describe('parseSSEChunk', () => {
  test('extracts content deltas from complete lines', () => {
    const { deltas, rest } = parseSSEChunk(dataLine('Hello') + dataLine(' world'));
    expect(deltas).toEqual(['Hello', ' world']);
    expect(rest).toBe('');
  });

  test('carries a partial trailing line forward via rest', () => {
    const full = dataLine('one') + dataLine('two');
    const split = Math.floor(full.length * 0.6);
    const first = parseSSEChunk(full.slice(0, split));
    const second = parseSSEChunk(first.rest + full.slice(split));
    expect([...first.deltas, ...second.deltas]).toEqual(['one', 'two']);
  });

  test('ignores the [DONE] sentinel', () => {
    const { deltas } = parseSSEChunk(dataLine('hi') + 'data: [DONE]\n');
    expect(deltas).toEqual(['hi']);
  });

  test('skips keep-alive comments and blank lines', () => {
    const { deltas } = parseSSEChunk(': keep-alive\n\n' + dataLine('x'));
    expect(deltas).toEqual(['x']);
  });

  test('tolerates malformed JSON without throwing', () => {
    const { deltas } = parseSSEChunk('data: {not json}\n' + dataLine('ok'));
    expect(deltas).toEqual(['ok']);
  });

  test('drops deltas that have no content field (e.g. role-only opener)', () => {
    const roleOnly = 'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }) + '\n';
    const { deltas } = parseSSEChunk(roleOnly + dataLine('body'));
    expect(deltas).toEqual(['body']);
  });

  test('handles CRLF line endings', () => {
    const body = dataLine('a').replace('\n', '\r\n') + dataLine('b').replace('\n', '\r\n');
    expect(parseSSEChunk(body).deltas).toEqual(['a', 'b']);
  });

  test('accepts data lines with no space after the colon', () => {
    const line = 'data:' + JSON.stringify({ choices: [{ delta: { content: 'tight' } }] }) + '\n';
    expect(parseSSEChunk(line).deltas).toEqual(['tight']);
  });

  test('survives a JSON payload that is not an object', () => {
    expect(() => parseSSEChunk('data: null\n' + 'data: "str"\n' + 'data: 42\n')).not.toThrow();
    expect(parseSSEChunk('data: null\n' + dataLine('ok')).deltas).toEqual(['ok']);
  });

  test('ignores the trailing usage-only frame Groq sends with empty choices', () => {
    const usage = 'data: ' + JSON.stringify({ choices: [], x_groq: { usage: { total_tokens: 9 } } }) + '\n';
    const { deltas } = parseSSEChunk(dataLine('done') + usage);
    expect(deltas).toEqual(['done']);
  });

  test('skips empty-string deltas instead of emitting useless events', () => {
    // An empty delta would still trigger an IPC round-trip and a DOM diff in
    // the renderer for literally nothing.
    const { deltas } = parseSSEChunk(dataLine('') + dataLine('real'));
    expect(deltas).toEqual(['real']);
  });

  test('skips a null content delta', () => {
    const nullContent = 'data: ' + JSON.stringify({ choices: [{ delta: { content: null } }] }) + '\n';
    const { deltas } = parseSSEChunk(nullContent + dataLine('ok'));
    expect(deltas).toEqual(['ok']);
  });

  test('ignores non-string content instead of emitting objects as answer text', () => {
    const invalid = 'data: ' + JSON.stringify({ choices: [{ delta: { content: { text: 'bad' } } }] }) + '\n';
    expect(parseSSEChunk(invalid + dataLine('ok')).deltas).toEqual(['ok']);
  });

  test('surfaces an SSE error after any preceding content and stops at the error', () => {
    const error = { message: 'Generation failed', code: 'server_error' };
    const chunk = dataLine('partial') + 'data: ' + JSON.stringify({ error }) + '\n' + dataLine('ignored');
    expect(parseSSEChunk(chunk)).toEqual({ deltas: ['partial'], rest: '', error });
  });

  test('marks DONE and ignores any trailing content in the same chunk', () => {
    expect(parseSSEChunk(dataLine('answer') + 'data: [DONE]\n' + dataLine('ignored')))
      .toEqual({ deltas: ['answer'], rest: '', done: true });
  });

  test('ignores event: lines (only data: lines carry content)', () => {
    const { deltas } = parseSSEChunk('event: message\n' + dataLine('x'));
    expect(deltas).toEqual(['x']);
  });

  test('handles a data line split mid-JSON across two chunks', () => {
    const line = dataLine('split across reads');
    const cut = line.indexOf('across'); // land squarely inside the JSON payload
    const first = parseSSEChunk(line.slice(0, cut));
    expect(first.deltas).toEqual([]); // incomplete line: nothing emitted, nothing lost
    expect(first.rest).toBe(line.slice(0, cut));

    const second = parseSSEChunk(first.rest + line.slice(cut));
    expect(second.deltas).toEqual(['split across reads']);
    expect(second.rest).toBe('');
  });

  test('ignores the [DONE] sentinel with CRLF line endings too', () => {
    const { deltas } = parseSSEChunk(dataLine('hi') + 'data: [DONE]\r\n');
    expect(deltas).toEqual(['hi']);
  });

  test('a single chunk containing data lines, a comment, and [DONE] emits exactly the content', () => {
    const chunk = ': keep-alive\n' + dataLine('a') + '\n' + dataLine('b') + 'data: [DONE]\n\n';
    const { deltas, rest } = parseSSEChunk(chunk);
    expect(deltas).toEqual(['a', 'b']);
    expect(rest).toBe('');
  });
});

describe('parseSSETail', () => {
  // Regression: parseSSEChunk can only emit newline-terminated lines, so a
  // stream that ends mid-line used to strand its last delta in `rest` forever.
  test('recovers a final data line that arrived without a trailing newline', () => {
    const body = dataLine('Hello') + 'data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] });
    const { deltas, rest } = parseSSEChunk(body);
    expect(deltas).toEqual(['Hello']); // the last delta is NOT here...
    expect(parseSSETail(rest).deltas).toEqual([' world']); // ...it is only recovered by the flush
  });

  test('an unterminated stream loses nothing end to end', () => {
    const body = dataLine('a') + dataLine('b') + 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'c' } }] });
    expect(drain(body)).toEqual(['a', 'b', 'c']);
  });

  test('returns nothing for an empty or whitespace-only tail', () => {
    expect(parseSSETail('').deltas).toEqual([]);
    expect(parseSSETail('\n').deltas).toEqual([]);
    expect(parseSSETail('   ').deltas).toEqual([]);
  });

  test('discards a genuinely truncated JSON payload instead of throwing', () => {
    expect(parseSSETail('data: {"choices":[{"delta":{"cont').deltas).toEqual([]);
  });

  test('does not double-emit when the stream ended cleanly with [DONE]', () => {
    const body = dataLine('a') + dataLine('b') + 'data: [DONE]\n\n';
    expect(drain(body)).toEqual(['a', 'b']);
  });

  test('is idempotent for a tail that is already newline-terminated', () => {
    expect(parseSSETail(dataLine('x')).deltas).toEqual(['x']);
  });

  test('ignores a tail that is only the [DONE] sentinel without a newline', () => {
    expect(parseSSETail('data: [DONE]').deltas).toEqual([]);
  });

  test('ignores a comment-only tail', () => {
    expect(parseSSETail(': keep-alive').deltas).toEqual([]);
  });

  test('surfaces an error delivered without a trailing newline', () => {
    expect(parseSSETail('data: {"error":{"message":"Generation failed"}}'))
      .toEqual({ deltas: [], error: { message: 'Generation failed' } });
  });
});

describe('end-to-end chunking', () => {
  test('byte-at-a-time delivery produces the same deltas as one big chunk', () => {
    const body = dataLine('Hello, ') + dataLine('world') + dataLine('!') + 'data: [DONE]\n\n';
    expect(drain(body, 1)).toEqual(['Hello, ', 'world', '!']);
    expect(drain(body)).toEqual(['Hello, ', 'world', '!']);
  });

  test('multi-byte characters split across chunk boundaries are not corrupted', () => {
    // The decoder-level guard lives in groq.ts; this pins the parser half:
    // a delta containing non-ASCII must survive line reassembly intact.
    const body = dataLine('café — ☕') + 'data: [DONE]\n\n';
    expect(drain(body, 3)).toEqual(['café — ☕']);
  });

  test('cutting the stream at every byte boundary yields identical deltas', () => {
    // A network read can end anywhere: inside "data:", mid-JSON, between \r
    // and \n, inside [DONE]. Exhaustively cutting one realistic body at every
    // index proves the deltas/rest contract has no position-dependent hole.
    const body =
      ': keep-alive\n' + dataLine('Hello, ') + '\n' + dataLine('world').replace('\n', '\r\n') + 'data: [DONE]\n\n';
    const expected = ['Hello, ', 'world'];
    for (let cut = 0; cut <= body.length; cut++) {
      const first = parseSSEChunk(body.slice(0, cut));
      const second = parseSSEChunk(first.rest + body.slice(cut));
      const tail = parseSSETail(second.rest);
      expect([...first.deltas, ...second.deltas, ...tail.deltas]).toEqual(expected);
    }
  });
});

describe('parseSSEChunk buffer bookkeeping', () => {
  test('[DONE] mid-buffer skips only itself — later lines in the same chunk still parse', () => {
    // [DONE] is a sentinel to ignore, not a terminator: the read loop ends when
    // the stream closes. Treating it as end-of-parse would drop any bytes an
    // unusual server (or a coalescing proxy) packed after it.
    const { deltas, rest } = parseSSEChunk(dataLine('a') + 'data: [DONE]\n' + dataLine('b'));
    expect(deltas).toEqual(['a']);
    expect(rest).toBe('');
  });

  test('an all-CRLF stream with comments interleaved between events parses like LF', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const body = crlf(': ka\n' + dataLine('a') + '\n' + ': ka\n' + dataLine('b') + 'data: [DONE]\n\n');
    const { deltas, rest } = parseSSEChunk(body);
    expect(deltas).toEqual(['a', 'b']);
    expect(rest).toBe('');
  });

  test('a data line with an empty or whitespace payload is ignored, not parsed', () => {
    // JSON.parse('') throws; these lines must burn in the try/catch without
    // taking the surrounding chunk's real deltas with them.
    expect(() => parseSSEChunk('data:\n' + 'data:   \n' + dataLine('ok'))).not.toThrow();
    expect(parseSSEChunk('data:\n' + 'data:   \n' + dataLine('ok')).deltas).toEqual(['ok']);
  });

  test('rest is byte-exact: empty after a clean newline, the partial line otherwise', () => {
    // The caller carries `rest` forward verbatim and prepends the next chunk;
    // a single byte lost or duplicated here corrupts the reassembled line.
    expect(parseSSEChunk(dataLine('x')).rest).toBe('');
    const partial = 'data: {"choices":[{"delta":{"cont';
    expect(parseSSEChunk(dataLine('x') + partial).rest).toBe(partial);
    expect(parseSSEChunk(partial).rest).toBe(partial); // no newline at all: everything carries forward
  });
});

describe('parseSSETail line endings', () => {
  test('recovers a final line terminated by a bare CR', () => {
    // A CRLF stream truncated between the \r and the \n leaves the \r in the
    // tail; the flush must still strip it and recover the delta.
    const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'end' } }] }) + '\r';
    expect(parseSSETail(line).deltas).toEqual(['end']);
  });
});

describe('usage extraction', () => {
  const usageChunk = (u: object) => 'data: ' + JSON.stringify({ choices: [], usage: u }) + '\n';

  test('surfaces the usage object from a final chunk', () => {
    const body = dataLine('hi') + usageChunk({ prompt_tokens: 12, completion_tokens: 3 });
    const { deltas, usage } = parseSSEChunk(body);
    expect(deltas).toEqual(['hi']);
    expect(usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
  });

  test('omits the usage key entirely when no chunk carried one', () => {
    const result = parseSSEChunk(dataLine('hi'));
    expect('usage' in result).toBe(false);
  });

  test("reads Groq's x_groq mirror when the top-level usage is absent", () => {
    const line = 'data: ' + JSON.stringify({ choices: [], x_groq: { usage: { prompt_tokens: 7, completion_tokens: 2 } } }) + '\n';
    expect(parseSSEChunk(line).usage).toEqual({ prompt_tokens: 7, completion_tokens: 2 });
  });

  test('the last usage seen wins when several chunks carry one', () => {
    const body = usageChunk({ prompt_tokens: 1, completion_tokens: 0 }) + usageChunk({ prompt_tokens: 12, completion_tokens: 5 });
    expect(parseSSEChunk(body).usage).toEqual({ prompt_tokens: 12, completion_tokens: 5 });
  });

  test('recovers usage from an unterminated tail line', () => {
    const tail = 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    const { deltas, usage } = parseSSETail(tail);
    expect(deltas).toEqual([]);
    expect(usage).toEqual({ prompt_tokens: 9, completion_tokens: 4 });
  });

  test('a non-object usage value is ignored', () => {
    const line = 'data: ' + JSON.stringify({ choices: [], usage: 'lots' }) + '\n';
    expect('usage' in parseSSEChunk(line)).toBe(false);
  });
});
