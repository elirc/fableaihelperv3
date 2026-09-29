import { describe, expect, test } from 'vitest';
import type { AnswerMetrics } from '../src/shared/types';
import {
  costLabel,
  costTitle,
  errorMessage,
  formatAccelerator,
  formatTimer,
  latencyLabel,
  latencyTitle,
} from '../src/renderer/format';

/** Build AnswerMetrics without repeating all three fields in every test. */
const metrics = (firstTokenMs: number, sttFinalizeMs = 0, totalMs = 0): AnswerMetrics => ({
  sttFinalizeMs,
  firstTokenMs,
  totalMs,
});

describe('formatAccelerator', () => {
  test('CommandOrControl renders as Ctrl', () => {
    expect(formatAccelerator('CommandOrControl')).toBe('Ctrl');
  });

  test('CmdOrCtrl renders as Ctrl', () => {
    expect(formatAccelerator('CmdOrCtrl')).toBe('Ctrl');
  });

  test('Control and Ctrl both render as Ctrl', () => {
    expect(formatAccelerator('Control')).toBe('Ctrl');
    expect(formatAccelerator('Ctrl')).toBe('Ctrl');
  });

  test('modifier matching is case-insensitive', () => {
    expect(formatAccelerator('CTRL')).toBe('Ctrl');
    expect(formatAccelerator('commandorcontrol')).toBe('Ctrl');
    expect(formatAccelerator('sHiFt')).toBe('Shift');
  });

  test('Command, Cmd, Super and Meta all render as Win', () => {
    expect(formatAccelerator('Command')).toBe('Win');
    expect(formatAccelerator('Cmd')).toBe('Win');
    expect(formatAccelerator('Super')).toBe('Win');
    expect(formatAccelerator('Meta')).toBe('Win');
  });

  test('Option and Alt both render as Alt', () => {
    expect(formatAccelerator('Option')).toBe('Alt');
    expect(formatAccelerator('Alt')).toBe('Alt');
  });

  test('Shift renders as Shift', () => {
    expect(formatAccelerator('Shift')).toBe('Shift');
  });

  test('single letters are uppercased', () => {
    expect(formatAccelerator('a')).toBe('A');
    expect(formatAccelerator('Ctrl+x')).toBe('Ctrl+X');
  });

  test('multi-token accelerators join with +', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space')).toBe('Ctrl+Shift+Space');
    expect(formatAccelerator('Alt+Shift+p')).toBe('Alt+Shift+P');
  });

  test('unknown multi-character tokens pass through untouched', () => {
    expect(formatAccelerator('Space')).toBe('Space');
    expect(formatAccelerator('F11')).toBe('F11');
    expect(formatAccelerator('Ctrl+PageDown')).toBe('Ctrl+PageDown');
  });

  test('whitespace around tokens is trimmed', () => {
    expect(formatAccelerator(' Ctrl + Shift + a ')).toBe('Ctrl+Shift+A');
  });

  test('empty accelerator stays empty', () => {
    expect(formatAccelerator('')).toBe('');
  });
});

describe('formatTimer', () => {
  test('0 seconds is 00:00', () => {
    expect(formatTimer(0)).toBe('00:00');
  });

  test('59 seconds is 00:59', () => {
    expect(formatTimer(59)).toBe('00:59');
  });

  test('60 seconds rolls over to 01:00', () => {
    expect(formatTimer(60)).toBe('01:00');
  });

  test('605 seconds is 10:05 (both halves zero-padded)', () => {
    expect(formatTimer(605)).toBe('10:05');
  });

  test('last second before the hour is 59:59', () => {
    expect(formatTimer(3599)).toBe('59:59');
  });

  test('large values let the minutes field grow past two digits', () => {
    expect(formatTimer(3600)).toBe('60:00');
    expect(formatTimer(7325)).toBe('122:05');
  });
});

describe('errorMessage', () => {
  test('AppError-shaped object yields its message', () => {
    expect(errorMessage({ code: 'stt_error', message: 'socket dropped mid-stream' })).toBe(
      'socket dropped mid-stream',
    );
  });

  test('plain Error yields its message', () => {
    expect(errorMessage(new Error('kaput'))).toBe('kaput');
  });

  test('non-string message property is coerced to a string', () => {
    expect(errorMessage({ message: 42 })).toBe('42');
  });

  test('string passes through unchanged', () => {
    expect(errorMessage('already readable')).toBe('already readable');
  });

  test('number is stringified', () => {
    expect(errorMessage(500)).toBe('500');
  });

  test('null and undefined stringify rather than throw', () => {
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });

  test('object without a message field falls back to String()', () => {
    expect(errorMessage({ code: 'internal' })).toBe('[object Object]');
  });
});

describe('latencyLabel', () => {
  test('1234 ms rounds to "1.2s to first token received"', () => {
    expect(latencyLabel(metrics(1234))).toBe('1.2s to first token received');
  });

  test('rounds up when the hundredths carry (1270 ms → 1.3s)', () => {
    expect(latencyLabel(metrics(1270))).toBe('1.3s to first token received');
  });

  test('sub-100ms values keep one decimal (0 ms → 0.0s)', () => {
    expect(latencyLabel(metrics(0))).toBe('0.0s to first token received');
  });

  test('1999 ms rounds to a whole "2.0s"', () => {
    expect(latencyLabel(metrics(1999))).toBe('2.0s to first token received');
  });

  test('double-digit seconds keep the same shape (12340 ms → 12.3s)', () => {
    expect(latencyLabel(metrics(12340))).toBe('12.3s to first token received');
  });
});

describe('latencyTitle', () => {
  test('mixes rounded ms for the stages with one-decimal seconds for the total', () => {
    expect(latencyTitle(metrics(1234.6, 480.4, 5678))).toBe(
      'First token received 1235 ms after Stop / Ask · transcript finalized 480 ms · full answer 5.7 s',
    );
  });

  test('integer inputs render without decimals in the ms fields', () => {
    expect(latencyTitle(metrics(900, 120, 3000))).toBe(
      'First token received 900 ms after Stop / Ask · transcript finalized 120 ms · full answer 3.0 s',
    );
  });

  test('a typed question (sttFinalizeMs = 0) reads "finalized 0 ms"', () => {
    expect(latencyTitle(metrics(700, 0, 2500))).toBe(
      'First token received 700 ms after Stop / Ask · transcript finalized 0 ms · full answer 2.5 s',
    );
  });
});

describe('formatAccelerator edge cases', () => {
  test('mixed weird casing normalizes modifiers but leaves unknown tokens alone', () => {
    // Modifier matching lowercases before the switch; unknown multi-char
    // tokens must pass through with their user-typed casing intact.
    expect(formatAccelerator('cOnTrOl+sHIFT+f5')).toBe('Ctrl+Shift+f5');
  });

  test('empty tokens from doubled plus signs round-trip without crashing', () => {
    // A half-typed accelerator in Settings can contain empty segments; the
    // formatter must reproduce them rather than throw or collapse the string.
    expect(formatAccelerator('Ctrl++')).toBe('Ctrl++');
    expect(formatAccelerator('+')).toBe('+');
  });

  test('only single characters are case-normalized, multi-char names are not', () => {
    // The uppercase rule is for key caps (a → A); applying it to key names
    // would corrupt valid Electron tokens like PageDown.
    expect(formatAccelerator('space')).toBe('space');
    expect(formatAccelerator('Ctrl+pageDown')).toBe('Ctrl+pageDown');
  });
});

describe('formatTimer out-of-contract inputs', () => {
  test('negative seconds produce a string instead of throwing', () => {
    // The timer source never goes negative, but a clock-skew bug upstream must
    // degrade to an odd label, not a render crash. Pinned so a change to the
    // ugly-but-safe output is deliberate.
    expect(formatTimer(-1)).toBe('-1:-1');
    expect(formatTimer(-61)).toBe('-2:-1');
  });

  test('huge durations grow the minutes field without wrapping', () => {
    // 100 hours: the minutes field keeps growing rather than overflowing into
    // garbage, matching the documented "minutes keep growing" contract.
    expect(formatTimer(360000)).toBe('6000:00');
  });

  test('fractional seconds leak into the seconds field — the contract is whole seconds', () => {
    // Documents that callers must floor before calling; the helper does not
    // hide a caller that starts passing raw millisecond math.
    expect(formatTimer(90.5)).toBe('01:30.5');
  });
});

describe('errorMessage edge cases', () => {
  test('Error subclasses yield their message like plain Error', () => {
    // `'message' in err` sees inherited properties, so TypeError/DOMException
    // and friends all surface their message, not their stringified form.
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  test('an empty message string is returned as-is, not replaced', () => {
    // The guard checks key presence, not truthiness; an empty message must not
    // fall through to '[object Object]'.
    expect(errorMessage({ message: '' })).toBe('');
  });

  test('a null message coerces to the string "null"', () => {
    // `'message' in err` is true for a null value; String() must keep the
    // coercion total instead of throwing on a property access.
    expect(errorMessage({ message: null })).toBe('null');
  });

  test('an array without a message falls back to String()', () => {
    // Arrays are objects, so they take the `in` branch check; without the key
    // they must still stringify via the fallback, empty or not.
    expect(errorMessage([])).toBe('');
    expect(errorMessage(['a', 'b'])).toBe('a,b');
  });

  test('an object-valued message coerces through its own String() form', () => {
    // Coercion delegates to the value's toString; a structured message object
    // degrades to something printable rather than crashing the error box.
    expect(errorMessage({ message: {} })).toBe('[object Object]');
    expect(errorMessage({ message: { toString: () => 'custom detail' } })).toBe('custom detail');
  });
});

describe('latencyLabel edge cases', () => {
  test('an exact half-tenth (1250 ms) rounds up to 1.3s', () => {
    // toFixed resolves ties toward the larger value; pinned so a refactor to
    // manual rounding cannot silently flip the boundary readings.
    expect(latencyLabel(metrics(1250))).toBe('1.3s to first token received');
  });

  test('a near-timeout value keeps the same template (999999 ms → 1000.0s)', () => {
    // Even absurd latencies must produce the honest number in the same shape,
    // not scientific notation or a clamped lie.
    expect(latencyLabel(metrics(999999))).toBe('1000.0s to first token received');
  });
});

describe('latencyTitle edge cases', () => {
  test('half-millisecond stage values round half up via Math.round', () => {
    // performance.now() feeds fractional ms; the .5 tie must round predictably
    // in both stage fields.
    expect(latencyTitle(metrics(100.5, 0.5, 1000))).toBe(
      'First token received 101 ms after Stop / Ask · transcript finalized 1 ms · full answer 1.0 s',
    );
  });

  test('all-zero metrics still format cleanly', () => {
    // An instant-failure session reports zeros; the breakdown must render the
    // template rather than hiding fields or dividing oddly.
    expect(latencyTitle(metrics(0, 0, 0))).toBe(
      'First token received 0 ms after Stop / Ask · transcript finalized 0 ms · full answer 0.0 s',
    );
  });
});

describe('costLabel / costTitle', () => {
  const base = { sttFinalizeMs: 100, firstTokenMs: 800, totalMs: 2000 };
  const usage = (over: object = {}) => ({
    model: 'claude-haiku-4-5',
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estCostUsd: 0.003,
    ...over,
  });

  test('empty when the provider reported no usage (chip hides itself)', () => {
    expect(costLabel(base)).toBe('');
    expect(costTitle(base)).toBe('');
  });

  test('shows dollars to four decimals when a cost estimate exists', () => {
    expect(costLabel({ ...base, usage: usage() })).toBe('$0.0030');
  });

  test('four decimals keep sub-cent answers visible instead of "$0.00"', () => {
    expect(costLabel({ ...base, usage: usage({ estCostUsd: 0.0004 }) })).toBe('$0.0004');
  });

  test('falls back to a token count when pricing is not pinned (Groq)', () => {
    const label = costLabel({
      ...base,
      usage: usage({ model: 'openai/gpt-oss-120b', estCostUsd: undefined }),
    });
    expect(label).toBe('1500→300 tok');
  });

  test('token fallback counts cached tokens as input — they were real prompt tokens', () => {
    const label = costLabel({
      ...base,
      usage: usage({ estCostUsd: undefined, inputTokens: 100, cacheReadTokens: 900 }),
    });
    expect(label).toBe('1000→300 tok');
  });

  test('title names the model and the in/out split', () => {
    const title = costTitle({ ...base, usage: usage() });
    expect(title).toContain('claude-haiku-4-5');
    expect(title).toContain('1500 in / 300 out');
  });

  test('title mentions cache lines only when caching actually engaged', () => {
    expect(costTitle({ ...base, usage: usage() })).not.toMatch(/cache/i);
    const engaged = costTitle({ ...base, usage: usage({ cacheReadTokens: 1200 }) });
    expect(engaged).toContain('1200 cached read (0.1x)');
  });

  test('title explains an absent estimate instead of leaving a bare token count', () => {
    const title = costTitle({ ...base, usage: usage({ estCostUsd: undefined }) });
    expect(title).toMatch(/pricing not pinned/i);
  });
});
