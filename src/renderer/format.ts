// Pure display-string helpers for the renderer. No DOM, no side effects —
// everything here is unit-testable in a plain node environment.

import type { AnswerMetrics, AppError } from '../shared/types';

/** Electron accelerator -> what the key caps actually say on Windows. */
export function formatAccelerator(accel: string): string {
  return accel
    .split('+')
    .map((raw) => {
      const p = raw.trim();
      switch (p.toLowerCase()) {
        case 'commandorcontrol':
        case 'cmdorctrl':
        case 'control':
        case 'ctrl':
          return 'Ctrl';
        case 'command':
        case 'cmd':
        case 'super':
        case 'meta':
          return 'Win';
        case 'option':
        case 'alt':
          return 'Alt';
        case 'shift':
          return 'Shift';
        default:
          return p.length === 1 ? p.toUpperCase() : p;
      }
    })
    .join('+');
}

/** Whole seconds -> zero-padded "mm:ss" (minutes keep growing past 99:59). */
export function formatTimer(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Best human-readable message for anything a promise can reject with. */
export function errorMessage(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err
    ? String((err as AppError).message)
    : String(err);
}

/** The headline latency chip: the one number this app exists to keep small. */
export function latencyLabel(m: AnswerMetrics): string {
  return `${(m.firstTokenMs / 1000).toFixed(1)}s to first token received`;
}

/** Hover breakdown for the latency chip: per-stage timings behind the headline. */
export function latencyTitle(m: AnswerMetrics): string {
  return (
    `First token received ${Math.round(m.firstTokenMs)} ms after Stop / Ask · ` +
    `transcript finalized ${Math.round(m.sttFinalizeMs)} ms · ` +
    `full answer ${(m.totalMs / 1000).toFixed(1)} s`
  );
}
