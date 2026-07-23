// A tiny markdown subset for streamed model output: paragraphs, headings,
// bullet/numbered lists, fenced code, thematic breaks, bold, italic, inline code.
//
// Split into two layers on purpose:
//   parseMarkdown()      pure, no DOM  -> unit-tested in test/markdown.test.ts
//   createMarkdownView() AST -> DOM nodes
//
// SECURITY — this renders untrusted model output:
//   * every string reaches the page via createTextNode()/textContent, never
//     innerHTML and never an attribute value derived from model text;
//   * links are deliberately NOT parsed, so there is no href to sanitize and no
//     javascript:/data: URL to smuggle. `[text](url)` degrades to literal text.
//   * no inline styles or scripts are produced, so the page CSP
//     (`default-src 'self'; style-src 'self'`) needs no relaxing — blocks are
//     styled purely by class names that live in styles.css.
//
// Streaming: update() diffs at block level against the previously rendered
// blocks and only rebuilds the diverged tail, so completed paragraphs keep
// their DOM nodes (no flicker, no lost text selection, no scroll jump).

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] };

export type Block =
  | { type: 'p'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; start: number; items: Inline[][] }
  | { type: 'code'; text: string }
  | { type: 'hr' };

const ESCAPABLE = '\\`*_{}[]()#+-.!>~';

const UL_RE = /^[ \t]*[-*+][ \t]+(.*)$/;
const OL_RE = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;
// A closing hash run is only decorative when preceded by whitespace, so
// "## Tips ##" strips to "Tips" but "### Experience with C#" keeps its "#".
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

const isWord = (ch: string): boolean => /[0-9A-Za-z]/.test(ch);
const isBlank = (line: string): boolean => line.trim() === '';

// ---------- inline ----------

/** True when a `*`/`_` run at `i` may open emphasis (left-flanking, non-intraword for `_`). */
function canOpen(src: string, i: number, c: string): boolean {
  const double = src.charAt(i + 1) === c;
  const after = src.charAt(i + (double ? 2 : 1));
  if (after === '' || /\s/.test(after)) return false;
  // `snake_case` must not turn into emphasis; `*` is allowed intraword.
  if (c === '_' && i > 0 && isWord(src.charAt(i - 1))) return false;
  return true;
}

/** Index of the closing delimiter for emphasis opened at `from`, or -1. */
function findClose(src: string, from: number, delim: string, c: string): number {
  let j = from;
  while (j < src.length) {
    const at = src.indexOf(delim, j);
    if (at === -1) return -1;
    if (at === from) {
      j = at + delim.length; // empty content: `**` / `__`
      continue;
    }
    if (src.charAt(at - 1) === '\\' || /\s/.test(src.charAt(at - 1))) {
      j = at + delim.length; // escaped, or not right-flanking
      continue;
    }
    if (delim.length === 1 && src.charAt(at + 1) === c) {
      j = at + 1; // part of a longer run, e.g. the `**` inside `*a**`
      continue;
    }
    if (delim.length === 1 && src.charAt(at - 1) === c && src.charAt(at - 2) !== '\\') {
      // Also part of a longer run, seen from its far end: without this, the
      // second `*` of the `**` in `*a **b** c*` closed the emphasis early.
      // (An escaped `\*` before the candidate is literal text, not a run.)
      j = at + delim.length;
      continue;
    }
    if (c === '_' && isWord(src.charAt(at + delim.length))) {
      j = at + delim.length; // intraword `_`
      continue;
    }
    return at;
  }
  return -1;
}

/** CommonMark: one space of padding on both sides of inline code is dropped. */
function stripCodePadding(s: string): string {
  if (s.length > 2 && s.startsWith(' ') && s.endsWith(' ') && s.trim() !== '') return s.slice(1, -1);
  return s;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      out.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);

    if (c === '\\') {
      const next = src.charAt(i + 1);
      if (next !== '' && ESCAPABLE.includes(next)) {
        buf += next;
        i += 2;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '`') {
      let run = 1;
      while (src.charAt(i + run) === '`') run += 1;
      const fence = '`'.repeat(run);
      // CommonMark: the closing run must be *exactly* as long as the opener,
      // so `` ` `` closes against the final lone backtick in "` `` `", not the
      // first backtick of the longer inner run.
      let close = -1;
      let k = i + run;
      while (k < src.length) {
        const at = src.indexOf(fence, k);
        if (at === -1) break;
        let len = run;
        while (src.charAt(at + len) === '`') len += 1;
        if (len === run) {
          close = at;
          break;
        }
        k = at + len; // skip the whole longer run
      }
      if (close !== -1) {
        flush();
        out.push({ type: 'code', value: stripCodePadding(src.slice(i + run, close)) });
        i = close + run;
        continue;
      }
      // Unterminated (common mid-stream): keep the backticks literal for now.
      buf += fence;
      i += run;
      continue;
    }

    if ((c === '*' || c === '_') && canOpen(src, i, c)) {
      const double = src.charAt(i + 1) === c;
      const delim = double ? c + c : c;
      const from = i + delim.length;
      const close = findClose(src, from, delim, c);
      if (close !== -1) {
        flush();
        const children = parseInline(src.slice(from, close));
        out.push(double ? { type: 'strong', children } : { type: 'em', children });
        i = close + delim.length;
        continue;
      }
      buf += delim;
      i += delim.length;
      continue;
    }

    buf += c;
    i += 1;
  }

  flush();
  return out;
}

// ---------- blocks ----------

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = (): void => {
    if (para.length === 0) return;
    // Soft-wrapped lines join into one paragraph, as in markdown.
    blocks.push({ type: 'p', children: parseInline(para.join(' ')) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (isBlank(line)) {
      flushPara();
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1] ?? '```';
      const closeRe = new RegExp(`^ {0,3}\\${marker.charAt(0)}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closeRe.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence, or past the end while the block is still streaming
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    // Before the list check: `- - -` is a rule, not a bullet.
    if (HR_RE.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        children: parseInline(heading[2] ?? ''),
      });
      i += 1;
      continue;
    }

    const ul = UL_RE.exec(line);
    const ol = ul ? null : OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = ol !== null;
      const start = ordered ? Number.parseInt(ol?.[1] ?? '1', 10) : 1;
      const items: string[] = [];

      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (HR_RE.test(l)) break;

        const u = UL_RE.exec(l);
        const o = u ? null : OL_RE.exec(l);
        if (!ordered && u) {
          items.push(u[1] ?? '');
          i += 1;
          continue;
        }
        if (ordered && o) {
          items.push(o[2] ?? '');
          i += 1;
          continue;
        }
        if (u || o) break; // list type switched

        if (isBlank(l)) {
          // A blank line only ends the list if no item follows (loose list).
          const next = lines[i + 1] ?? '';
          const nextIsItem = ordered ? OL_RE.test(next) : UL_RE.test(next);
          if (nextIsItem && !HR_RE.test(next)) {
            i += 1;
            continue;
          }
          break;
        }
        if (FENCE_RE.test(l) || HEADING_RE.test(l)) break;

        // Lazy continuation of a wrapped item.
        const last = items.length - 1;
        if (last >= 0) {
          items[last] = `${items[last] ?? ''} ${l.trim()}`;
          i += 1;
          continue;
        }
        break;
      }

      const parsed = items.map((t) => parseInline(t));
      blocks.push(ordered ? { type: 'ol', start, items: parsed } : { type: 'ul', items: parsed });
      continue;
    }

    para.push(line.trim());
    i += 1;
  }

  flushPara();
  return blocks;
}

// ---------- DOM ----------

function appendInlines(parent: Node, nodes: Inline[]): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        parent.appendChild(document.createTextNode(n.value));
        break;
      case 'code': {
        const el = document.createElement('code');
        el.textContent = n.value;
        parent.appendChild(el);
        break;
      }
      case 'strong': {
        const el = document.createElement('strong');
        appendInlines(el, n.children);
        parent.appendChild(el);
        break;
      }
      case 'em': {
        const el = document.createElement('em');
        appendInlines(el, n.children);
        parent.appendChild(el);
        break;
      }
    }
  }
}

function renderBlock(b: Block): HTMLElement {
  switch (b.type) {
    case 'p': {
      const el = document.createElement('p');
      appendInlines(el, b.children);
      return el;
    }
    case 'heading': {
      // The page owns h1/h2; model headings start at h3 to keep the outline sane.
      const el = document.createElement(`h${Math.min(6, b.level + 2)}`);
      appendInlines(el, b.children);
      return el;
    }
    case 'ul': {
      const el = document.createElement('ul');
      for (const item of b.items) {
        const li = document.createElement('li');
        appendInlines(li, item);
        el.appendChild(li);
      }
      return el;
    }
    case 'ol': {
      const el = document.createElement('ol');
      if (b.start !== 1) el.start = b.start;
      for (const item of b.items) {
        const li = document.createElement('li');
        appendInlines(li, item);
        el.appendChild(li);
      }
      return el;
    }
    case 'code': {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = b.text;
      pre.appendChild(code);
      return pre;
    }
    case 'hr':
      return document.createElement('hr');
  }
}

export interface MarkdownView {
  /** Re-render `src`, reusing the DOM of blocks that did not change. */
  update(src: string): void;
  /** Replace the content with a muted placeholder line. */
  placeholder(text: string): void;
  clear(): void;
}

/**
 * Owns every child node of `container` — nothing else may append to it, or the
 * block/DOM index mapping below would drift.
 */
export function createMarkdownView(container: HTMLElement): MarkdownView {
  let keys: string[] = [];

  const reset = (): void => {
    container.replaceChildren();
    keys = [];
  };

  return {
    update(src: string): void {
      const blocks = parseMarkdown(src);
      const next = blocks.map((b) => JSON.stringify(b));

      let shared = 0;
      while (shared < keys.length && shared < next.length && keys[shared] === next[shared]) shared += 1;

      // Drop the diverged tail (also clears a placeholder, since keys is then empty).
      while (container.childNodes.length > shared) {
        const last = container.lastChild;
        if (!last) break;
        container.removeChild(last);
      }
      for (let i = shared; i < blocks.length; i += 1) {
        const b = blocks[i];
        if (b) container.appendChild(renderBlock(b));
      }
      keys = next;
    },

    placeholder(text: string): void {
      reset();
      const span = document.createElement('span');
      span.className = 'placeholder';
      span.textContent = text;
      container.appendChild(span);
    },

    clear: reset,
  };
}
