import { describe, expect, test } from 'vitest';
import { parseInline, parseMarkdown, type Block, type Inline } from '../src/renderer/markdown';

/** Flatten inline nodes to their visible text, ignoring emphasis. */
function text(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === 'text' || n.type === 'code' ? n.value : text(n.children)))
    .join('');
}

function blockText(b: Block): string {
  switch (b.type) {
    case 'p':
    case 'heading':
      return text(b.children);
    case 'ul':
    case 'ol':
      return b.items.map(text).join('|');
    case 'code':
      return b.text;
    case 'hr':
      return '';
  }
}

describe('parseInline', () => {
  test('plain text is one text node', () => {
    expect(parseInline('hello there')).toEqual([{ type: 'text', value: 'hello there' }]);
  });

  test('**bold** and *italic* and `code`', () => {
    expect(parseInline('a **b** c *d* e `f`')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'text', value: ' c ' },
      { type: 'em', children: [{ type: 'text', value: 'd' }] },
      { type: 'text', value: ' e ' },
      { type: 'code', value: 'f' },
    ]);
  });

  test('__bold__ and _italic_ underscore forms', () => {
    expect(parseInline('__b__ _i_')).toEqual([
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'text', value: ' ' },
      { type: 'em', children: [{ type: 'text', value: 'i' }] },
    ]);
  });

  test('intraword underscores stay literal (snake_case, not emphasis)', () => {
    expect(parseInline('use user_id_field here')).toEqual([
      { type: 'text', value: 'use user_id_field here' },
    ]);
  });

  test('emphasis nests inside bold', () => {
    expect(parseInline('**a *b* c**')).toEqual([
      {
        type: 'strong',
        children: [
          { type: 'text', value: 'a ' },
          { type: 'em', children: [{ type: 'text', value: 'b' }] },
          { type: 'text', value: ' c' },
        ],
      },
    ]);
  });

  test('inline code is not parsed for emphasis', () => {
    expect(parseInline('`a *b* c`')).toEqual([{ type: 'code', value: 'a *b* c' }]);
  });

  test('backslash escapes are honored', () => {
    expect(parseInline('\\*not italic\\*')).toEqual([{ type: 'text', value: '*not italic*' }]);
  });

  test('a * surrounded by spaces is literal, not emphasis', () => {
    expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', value: '2 * 3 * 4' }]);
  });

  // Streaming: partial delimiters arrive before their closers.
  test('unterminated bold stays literal mid-stream', () => {
    expect(parseInline('I **lead')).toEqual([{ type: 'text', value: 'I **lead' }]);
  });

  test('unterminated inline code stays literal mid-stream', () => {
    expect(parseInline('run `npm')).toEqual([{ type: 'text', value: 'run `npm' }]);
  });

  test('html in model output is kept as literal text, never markup', () => {
    const nodes = parseInline('<img src=x onerror="alert(1)"> & <b>hi</b>');
    expect(nodes).toEqual([{ type: 'text', value: '<img src=x onerror="alert(1)"> & <b>hi</b>' }]);
  });

  test('links are not parsed, so no href can ever be attacker-controlled', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { type: 'text', value: '[click](javascript:alert(1))' },
    ]);
  });
});

describe('parseMarkdown', () => {
  test('blank lines separate paragraphs', () => {
    const blocks = parseMarkdown('one\n\ntwo');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'p']);
    expect(blocks.map(blockText)).toEqual(['one', 'two']);
  });

  test('soft-wrapped lines join into a single paragraph', () => {
    const blocks = parseMarkdown('one\ntwo');
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0]!)).toBe('one two');
  });

  test('bullet lists with -, * and + markers', () => {
    for (const marker of ['-', '*', '+']) {
      const blocks = parseMarkdown(`${marker} a\n${marker} b`);
      expect(blocks[0]?.type).toBe('ul');
      expect(blockText(blocks[0]!)).toBe('a|b');
    }
  });

  test('numbered list keeps its start number', () => {
    const blocks = parseMarkdown('3. c\n4. d');
    expect(blocks[0]).toMatchObject({ type: 'ol', start: 3 });
    expect(blockText(blocks[0]!)).toBe('c|d');
  });

  test('numbered list accepts the 1) form', () => {
    const blocks = parseMarkdown('1) a\n2) b');
    expect(blocks[0]?.type).toBe('ol');
    expect(blockText(blocks[0]!)).toBe('a|b');
  });

  test('wrapped bullet text continues the same item', () => {
    const blocks = parseMarkdown('- first line\n  still first\n- second');
    expect(blockText(blocks[0]!)).toBe('first line still first|second');
  });

  test('switching from bullets to numbers starts a new list', () => {
    expect(parseMarkdown('- a\n1. b').map((b) => b.type)).toEqual(['ul', 'ol']);
  });

  test('a paragraph after a blank line ends the list', () => {
    const blocks = parseMarkdown('- a\n- b\n\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['ul', 'p']);
    expect(blockText(blocks[1]!)).toBe('after');
  });

  test('list items carry inline formatting', () => {
    const blocks = parseMarkdown('- **bold** item');
    expect(blocks[0]).toMatchObject({
      type: 'ul',
      items: [[{ type: 'strong', children: [{ type: 'text', value: 'bold' }] }, { type: 'text', value: ' item' }]],
    });
  });

  test('headings by level', () => {
    const blocks = parseMarkdown('# one\n\n### three');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, children: [{ type: 'text', value: 'one' }] },
      { type: 'heading', level: 3, children: [{ type: 'text', value: 'three' }] },
    ]);
  });

  test('fenced code keeps raw text and does not parse markdown inside', () => {
    const blocks = parseMarkdown('```js\nconst a = **1**;\n```');
    expect(blocks).toEqual([{ type: 'code', text: 'const a = **1**;' }]);
  });

  test('unterminated fence renders what has streamed so far', () => {
    expect(parseMarkdown('```\nhalf a line')).toEqual([{ type: 'code', text: 'half a line' }]);
  });

  test('thematic breaks, including - - - which also looks like a bullet', () => {
    expect(parseMarkdown('a\n\n---\n\nb').map((b) => b.type)).toEqual(['p', 'hr', 'p']);
    expect(parseMarkdown('- - -').map((b) => b.type)).toEqual(['hr']);
  });

  test('a rule ends an open list rather than joining it', () => {
    expect(parseMarkdown('- a\n---\n- b').map((b) => b.type)).toEqual(['ul', 'hr', 'ul']);
  });

  test('empty input yields no blocks', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });

  test('CRLF input parses like LF', () => {
    expect(parseMarkdown('a\r\n\r\n- b')).toEqual(parseMarkdown('a\n\n- b'));
  });

  test('a realistic streamed answer', () => {
    const answer = [
      'I led the **payments** migration at Acme.',
      '',
      'Key points:',
      '',
      '- Cut p99 latency from `900ms` to `120ms`',
      '- Zero downtime across 14 services',
      '',
      '1. Shadowed traffic for two weeks',
      '2. Flipped the flag per region',
    ].join('\n');
    expect(parseMarkdown(answer).map((b) => b.type)).toEqual(['p', 'p', 'ul', 'ol']);
  });

  // Every growing prefix must parse without throwing — this is the streaming path.
  test('every prefix of a streamed answer parses cleanly', () => {
    const answer = '## Story\n\nI **shipped** `v2` in:\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n';
    for (let i = 0; i <= answer.length; i += 1) {
      expect(() => parseMarkdown(answer.slice(0, i))).not.toThrow();
    }
    expect(parseMarkdown(answer).map((b) => b.type)).toEqual(['heading', 'p', 'ul', 'ol', 'code']);
  });
});
