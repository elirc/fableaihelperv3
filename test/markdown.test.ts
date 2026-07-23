// @vitest-environment happy-dom
//
// Two layers, mirroring the module: pure parser tests (no DOM needed, they
// just run under happy-dom because the pragma is per-file) and DOM-view tests
// for createMarkdownView — streaming block identity, placeholder lifecycle,
// and the never-innerHTML guarantee against hostile model output.
import { describe, expect, test } from 'vitest';
import {
  createMarkdownView,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline,
} from '../src/renderer/markdown';

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

  test('empty input yields no nodes', () => {
    expect(parseInline('')).toEqual([]);
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

  // Regression: the single-* closer scan skipped a candidate followed by `*`
  // but not one preceded by `*`, so the second char of the `**` run in
  // "*a **b** c*" closed the emphasis early: em("a *") + literal "b** c*".
  test('bold nests inside italic', () => {
    for (const src of ['*a **b** c*', '_a __b__ c_']) {
      expect(parseInline(src)).toEqual([
        {
          type: 'em',
          children: [
            { type: 'text', value: 'a ' },
            { type: 'strong', children: [{ type: 'text', value: 'b' }] },
            { type: 'text', value: ' c' },
          ],
        },
      ]);
    }
  });

  test('a ** run inside single emphasis stays literal, as in CommonMark', () => {
    // *a**b* pairs the outer single stars; the inner ** cannot close them.
    expect(parseInline('*a**b*')).toEqual([
      { type: 'em', children: [{ type: 'text', value: 'a**b' }] },
    ]);
  });

  test('an escaped star just before the closer does not hide it', () => {
    // *a\** — the \* is literal text, so the final * still closes: em("a*").
    expect(parseInline('*a\\**')).toEqual([
      { type: 'em', children: [{ type: 'text', value: 'a*' }] },
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

  test('double-backtick code spans may contain single backticks', () => {
    expect(parseInline('``a`b``')).toEqual([{ type: 'code', value: 'a`b' }]);
  });

  test('one space of code-span padding is stripped, all-space spans are kept', () => {
    expect(parseInline('` a `')).toEqual([{ type: 'code', value: 'a' }]);
    expect(parseInline('` `` `')).toEqual([{ type: 'code', value: '``' }]); // padding around a backtick
    expect(parseInline('`  `')).toEqual([{ type: 'code', value: '  ' }]); // only spaces: not padding
  });

  test('backslash escapes are honored', () => {
    expect(parseInline('\\*not italic\\*')).toEqual([{ type: 'text', value: '*not italic*' }]);
  });

  test('a backslash before a non-escapable char stays literal (Windows paths)', () => {
    expect(parseInline('C:\\njs\\node')).toEqual([{ type: 'text', value: 'C:\\njs\\node' }]);
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

  test.each([
    ['I **lead'],
    ['mid *ital'],
    ['x __b'],
    ['y _i'],
    ['run `npm'],
    ['trailing star *'],
    ['trailing backslash \\'],
    ['**** empty runs **'],
  ])('mid-stream state %j keeps every character visible', (src) => {
    // No delimiter may be silently dropped while its closer has not arrived.
    expect(text(parseInline(src))).toBe(src);
  });

  test('once the closing marker arrives, nothing is dropped or duplicated', () => {
    // The mid-stream prefix renders literally…
    expect(text(parseInline('I **lead'))).toBe('I **lead');
    // …and the completed string renders exactly once, as markup.
    expect(parseInline('I **lead** teams')).toEqual([
      { type: 'text', value: 'I ' },
      { type: 'strong', children: [{ type: 'text', value: 'lead' }] },
      { type: 'text', value: ' teams' },
    ]);
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

  test('trailing whitespace on paragraph lines is trimmed away', () => {
    expect(blockText(parseMarkdown('one   \ntwo  ')[0]!)).toBe('one two');
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

  test('a 10-digit "number" is a paragraph, not a list marker', () => {
    expect(parseMarkdown('1234567890. not a list')[0]?.type).toBe('p');
  });

  test('wrapped bullet text continues the same item', () => {
    const blocks = parseMarkdown('- first line\n  still first\n- second');
    expect(blockText(blocks[0]!)).toBe('first line still first|second');
  });

  test('switching from bullets to numbers starts a new list', () => {
    expect(parseMarkdown('- a\n1. b').map((b) => b.type)).toEqual(['ul', 'ol']);
  });

  test('switching from numbers to bullets starts a new list', () => {
    const blocks = parseMarkdown('1. a\n- b');
    expect(blocks.map((b) => b.type)).toEqual(['ol', 'ul']);
    expect(blocks.map(blockText)).toEqual(['a', 'b']);
  });

  test('a blank line between items keeps one list (loose list)', () => {
    const blocks = parseMarkdown('- a\n\n- b');
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0]!)).toBe('a|b');
  });

  test('a paragraph after a blank line ends the list', () => {
    const blocks = parseMarkdown('- a\n- b\n\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['ul', 'p']);
    expect(blockText(blocks[1]!)).toBe('after');
  });

  test('a fence or heading line ends an open list', () => {
    expect(parseMarkdown('- a\n```\ncode\n```').map((b) => b.type)).toEqual(['ul', 'code']);
    expect(parseMarkdown('- a\n# H').map((b) => b.type)).toEqual(['ul', 'heading']);
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

  // Regression: the old closing-hash strip did not require a preceding space,
  // so "### Experience with C#" rendered as "Experience with C".
  test('a trailing # that is part of a word survives (C#)', () => {
    expect(parseMarkdown('### Experience with C#')).toEqual([
      { type: 'heading', level: 3, children: [{ type: 'text', value: 'Experience with C#' }] },
    ]);
  });

  test('a space-separated closing hash run is stripped, interior hashes stay', () => {
    expect(blockText(parseMarkdown('## Tips ##')[0]!)).toBe('Tips');
    expect(blockText(parseMarkdown('# foo ## bar')[0]!)).toBe('foo ## bar');
  });

  test('#7 and seven hashes are paragraphs, not headings', () => {
    expect(parseMarkdown('#7 things')[0]?.type).toBe('p'); // no space after #
    expect(parseMarkdown('####### too deep')[0]?.type).toBe('p'); // > 6 hashes
  });

  test('headings tolerate up to three spaces of indent, like CommonMark', () => {
    expect(parseMarkdown('   ## indented')[0]).toMatchObject({ type: 'heading', level: 2 });
  });

  test('fenced code keeps raw text and does not parse markdown inside', () => {
    const blocks = parseMarkdown('```js\nconst a = **1**;\n```');
    expect(blocks).toEqual([{ type: 'code', text: 'const a = **1**;' }]);
  });

  test('unterminated fence renders what has streamed so far', () => {
    expect(parseMarkdown('```\nhalf a line')).toEqual([{ type: 'code', text: 'half a line' }]);
  });

  test('tilde fences work and blank lines inside a fence are preserved', () => {
    expect(parseMarkdown('~~~\na\n\nb\n~~~')).toEqual([{ type: 'code', text: 'a\n\nb' }]);
  });

  test('a closing fence must be at least as long as the opener', () => {
    // Four backticks open; three inside are content, four close.
    expect(parseMarkdown('````\nx\n```\ny\n````')).toEqual([{ type: 'code', text: 'x\n```\ny' }]);
    // A longer closer is fine.
    expect(parseMarkdown('```\nx\n`````')).toEqual([{ type: 'code', text: 'x' }]);
  });

  test('a "closing" fence with an info string does not close the block', () => {
    // CommonMark: only the opening fence may carry a language tag.
    expect(parseMarkdown('```js\nx\n``` js\ny\n```')).toEqual([
      { type: 'code', text: 'x\n``` js\ny' },
    ]);
  });

  test('thematic breaks, including - - - which also looks like a bullet', () => {
    expect(parseMarkdown('a\n\n---\n\nb').map((b) => b.type)).toEqual(['p', 'hr', 'p']);
    expect(parseMarkdown('- - -').map((b) => b.type)).toEqual(['hr']);
  });

  test('all three rule characters work, with or without trailing spaces', () => {
    for (const rule of ['***', '___', '- - -', '*  *  *  ', '---   ']) {
      expect(parseMarkdown(rule).map((b) => b.type)).toEqual(['hr']);
    }
  });

  test('a rule ends an open list rather than joining it', () => {
    expect(parseMarkdown('- a\n---\n- b').map((b) => b.type)).toEqual(['ul', 'hr', 'ul']);
  });

  test('a rule after a loose-list blank line is a rule, not the next item', () => {
    expect(parseMarkdown('- a\n\n- - -').map((b) => b.type)).toEqual(['ul', 'hr']);
  });

  test('setext headings are deliberately not supported: text then --- is p + hr', () => {
    expect(parseMarkdown('Title\n---').map((b) => b.type)).toEqual(['p', 'hr']);
  });

  test('empty input yields no blocks', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });

  test('CRLF input parses like LF', () => {
    expect(parseMarkdown('a\r\n\r\n- b')).toEqual(parseMarkdown('a\n\n- b'));
  });

  test('CRLF inside a fence does not leak \\r into the code text', () => {
    expect(parseMarkdown('```\r\ncode line\r\n```')).toEqual([{ type: 'code', text: 'code line' }]);
  });

  test('script tags and event handlers stay literal paragraph text', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'p']);
    expect(blocks.map(blockText)).toEqual(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>']);
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

// ---------- DOM view ----------

/** Every element in the subtree, depth first. */
function allElements(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function makeView(): { container: HTMLElement; view: ReturnType<typeof createMarkdownView> } {
  const container = document.createElement('div');
  return { container, view: createMarkdownView(container) };
}

describe('createMarkdownView', () => {
  test('renders each block type with the expected tag', () => {
    const { container, view } = makeView();
    view.update('# Head\n\npara **b** *i* `c`\n\n- one\n- two\n\n3. three\n4. four\n\n```\ncode\n```\n\n---');
    expect(Array.from(container.children).map((el) => el.tagName)).toEqual([
      'H3', 'P', 'UL', 'OL', 'PRE', 'HR',
    ]);
    const p = container.querySelector('p')!;
    expect(p.querySelector('strong')?.textContent).toBe('b');
    expect(p.querySelector('em')?.textContent).toBe('i');
    expect(p.querySelector('code')?.textContent).toBe('c');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelector('pre > code')?.textContent).toBe('code');
  });

  test('model headings map to h3–h6 so the page keeps h1/h2 for itself', () => {
    const { container, view } = makeView();
    view.update('# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f');
    expect(Array.from(container.children).map((el) => el.tagName)).toEqual([
      'H3', 'H4', 'H5', 'H6', 'H6', 'H6',
    ]);
  });

  test('ol start attribute appears only when the list does not start at 1', () => {
    const { container, view } = makeView();
    view.update('1. a\n\ntext\n\n5. b');
    const [first, second] = Array.from(container.querySelectorAll('ol'));
    expect(first?.getAttribute('start')).toBeNull();
    expect(second?.getAttribute('start')).toBe('5');
  });

  test('completed blocks keep their DOM nodes while the stream appends', () => {
    const { container, view } = makeView();
    view.update('First paragraph.\n\nSecond para');
    const [p1, p2] = Array.from(container.children);

    // The tail grows: only the growing block is rebuilt.
    view.update('First paragraph.\n\nSecond paragraph, finished.');
    expect(container.children[0]).toBe(p1);
    expect(container.children[1]).not.toBe(p2);
    const p2done = container.children[1];

    // A new block arrives: both completed paragraphs keep their nodes.
    view.update('First paragraph.\n\nSecond paragraph, finished.\n\n- item');
    expect(container.children[0]).toBe(p1);
    expect(container.children[1]).toBe(p2done);
    expect(container.children[2]?.tagName).toBe('UL');
  });

  test('a closing fence arriving later leaves the code node in place', () => {
    const { container, view } = makeView();
    view.update('```ts\nconst x = 1;');
    const pre = container.firstElementChild;
    expect(pre?.tagName).toBe('PRE');

    // The closer changes nothing about the AST, so the node must survive…
    view.update('```ts\nconst x = 1;\n```');
    expect(container.firstElementChild).toBe(pre);

    // …including when more content streams in after it.
    view.update('```ts\nconst x = 1;\n```\n\nAfter.');
    expect(container.firstElementChild).toBe(pre);
    expect(container.children[1]?.tagName).toBe('P');
  });

  test('the final update after completion is a DOM no-op', () => {
    const full = '## Done\n\nAll **set**.\n\n- a\n- b';
    const { container, view } = makeView();
    view.update(full);
    const refs = Array.from(container.children);

    view.update(full);
    expect(container.children).toHaveLength(refs.length);
    refs.forEach((el, i) => expect(container.children[i]).toBe(el));
  });

  test('incremental streaming converges to the same DOM as a one-shot render', () => {
    const answer =
      '## Story\n\nI **shipped** `v2` with *care*:\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n\n---\n\nDone.';
    const { container, view } = makeView();
    for (let i = 1; i <= answer.length; i += 1) view.update(answer.slice(0, i));

    const oneShot = makeView();
    oneShot.view.update(answer);
    expect(container.innerHTML).toBe(oneShot.container.innerHTML);
  });

  test('placeholder renders a muted line that the first update replaces', () => {
    const { container, view } = makeView();
    view.placeholder('Listening…');

    const span = container.firstElementChild;
    expect(container.children).toHaveLength(1);
    expect(span?.tagName).toBe('SPAN');
    expect(span?.className).toBe('placeholder');
    expect(span?.textContent).toBe('Listening…');

    view.update('First words.');
    expect(container.querySelector('.placeholder')).toBeNull();
    expect(container.firstElementChild?.tagName).toBe('P');
    expect(container.textContent).toBe('First words.');
  });

  test('clear empties the container and a later update starts fresh', () => {
    const { container, view } = makeView();
    view.update('some **answer**');
    view.clear();
    expect(container.childNodes).toHaveLength(0);

    view.update('next answer');
    expect(container.children).toHaveLength(1);
    expect(container.textContent).toBe('next answer');
  });

  test('updating to empty text removes everything', () => {
    const { container, view } = makeView();
    view.update('a\n\nb');
    view.update('');
    expect(container.childNodes).toHaveLength(0);
  });

  test.each([
    ['<script>alert(1)</script>'],
    ['<img src=x onerror=alert(1)>'],
    ['"><svg/onload=alert(1)>'],
    ['[x](javascript:alert(1))'],
    ['&lt;pre-escaped&gt; &amp; raw &'],
    ["'; DROP TABLE answers; --"],
  ])('hostile input %j becomes inert text, character for character', (evil) => {
    const { container, view } = makeView();
    view.update(evil);

    // Nothing model-controlled ever becomes markup: the only element is the
    // paragraph, it has no attributes, and its text is the input verbatim.
    expect(container.textContent).toBe(evil);
    expect(container.querySelector('script, img, svg, a, iframe')).toBeNull();
    for (const el of allElements(container)) {
      expect(el.tagName).toBe('P');
      expect(el.attributes).toHaveLength(0);
    }
  });

  test('hostile text inside emphasis and code blocks stays text too', () => {
    const { container, view } = makeView();
    view.update('**<b>bold</b>**\n\n```\n</script><script>alert(1)</script>\n```');

    expect(container.querySelector('strong')?.textContent).toBe('<b>bold</b>');
    expect(container.querySelector('pre > code')?.textContent).toBe(
      '</script><script>alert(1)</script>',
    );
    expect(container.querySelector('script, b')).toBeNull();
  });

  test('no element in a full render carries any attribute derived from text', () => {
    const { container, view } = makeView();
    view.update('# H " onmouseover="alert(1)\n\npara\n\n- item " onclick="x\n\n```\ncode\n```');
    for (const el of allElements(container)) {
      expect(el.attributes).toHaveLength(0);
    }
  });
});
