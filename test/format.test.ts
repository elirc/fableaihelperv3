import { describe, expect, test } from 'vitest';
import type { AnswerMetrics } from '../src/shared/types';
import {
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
  test('1234 ms rounds to "1.2s to first word"', () => {
    expect(latencyLabel(metrics(1234))).toBe('1.2s to first word');
  });

  test('rounds up when the hundredths carry (1270 ms → 1.3s)', () => {
    expect(latencyLabel(metrics(1270))).toBe('1.3s to first word');
  });

  test('sub-100ms values keep one decimal (0 ms → 0.0s)', () => {
    expect(latencyLabel(metrics(0))).toBe('0.0s to first word');
  });

  test('1999 ms rounds to a whole "2.0s"', () => {
    expect(latencyLabel(metrics(1999))).toBe('2.0s to first word');
  });

  test('double-digit seconds keep the same shape (12340 ms → 12.3s)', () => {
    expect(latencyLabel(metrics(12340))).toBe('12.3s to first word');
  });
});

describe('latencyTitle', () => {
  test('mixes rounded ms for the stages with one-decimal seconds for the total', () => {
    expect(latencyTitle(metrics(1234.6, 480.4, 5678))).toBe(
      'First word 1235 ms after Stop · transcript finalized 480 ms · full answer 5.7 s',
    );
  });

  test('integer inputs render without decimals in the ms fields', () => {
    expect(latencyTitle(metrics(900, 120, 3000))).toBe(
      'First word 900 ms after Stop · transcript finalized 120 ms · full answer 3.0 s',
    );
  });

  test('a typed question (sttFinalizeMs = 0) reads "finalized 0 ms"', () => {
    expect(latencyTitle(metrics(700, 0, 2500))).toBe(
      'First word 700 ms after Stop · transcript finalized 0 ms · full answer 2.5 s',
    );
  });
});
