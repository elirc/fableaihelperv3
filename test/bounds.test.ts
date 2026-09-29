import { describe, expect, test } from 'vitest';
import { MIN_VISIBLE_PX, sanitizeWindowBounds, type Rect, type WindowBounds } from '../src/main/bounds';

// sanitizeWindowBounds turns persisted geometry into safe BrowserWindow
// options. The invariants under test: a missing/garbage save falls back to the
// default size, sizes never go below the window minimum, and a position is
// kept only when enough of the window lands on a live display to grab it.

const DEFAULTS = { width: 460, height: 700 };
const MIN = { width: 380, height: 520 };
/** A single 1920x1080 primary display with a 40px taskbar. */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };

const run = (saved: WindowBounds | undefined, workAreas: Rect[] = [PRIMARY]) =>
  sanitizeWindowBounds(saved, workAreas, DEFAULTS, MIN);

describe('sanitizeWindowBounds fallback', () => {
  test('nothing saved (first run) returns the default size with no position', () => {
    expect(run(undefined)).toEqual({ width: 460, height: 700 });
  });

  test('non-finite coordinates are rejected wholesale', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(run({ x: bad, y: 10, width: 460, height: 700 })).toEqual(DEFAULTS);
      expect(run({ x: 10, y: bad, width: 460, height: 700 })).toEqual(DEFAULTS);
      expect(run({ x: 10, y: 10, width: bad, height: 700 })).toEqual(DEFAULTS);
      expect(run({ x: 10, y: 10, width: 460, height: bad })).toEqual(DEFAULTS);
    }
  });

  test('the returned object never aliases the saved bounds', () => {
    const saved = { x: 100, y: 100, width: 500, height: 600 };
    const out = run(saved);
    expect(out).not.toBe(saved);
    out.width = 9999;
    expect(saved.width).toBe(500);
  });
});

describe('sanitizeWindowBounds size clamping', () => {
  test('a saved size below the window minimum is clamped up', () => {
    // A hand-edited settings.json (or a bug in a past version) must not open
    // an unusably small window.
    expect(run({ x: 100, y: 100, width: 100, height: 90 })).toEqual({
      x: 100,
      y: 100,
      width: MIN.width,
      height: MIN.height,
    });
  });

  test('fractional geometry is rounded to integers', () => {
    // BrowserWindow expects integers; fractional values come from DPI-scaled
    // displays.
    expect(run({ x: 10.6, y: 20.4, width: 500.5, height: 600.5 })).toEqual({
      x: 11,
      y: 20,
      width: 501,
      height: 601,
    });
  });

  test('a valid on-screen save is returned unchanged', () => {
    expect(run({ x: 200, y: 150, width: 460, height: 700 })).toEqual({
      x: 200,
      y: 150,
      width: 460,
      height: 700,
    });
  });
});

describe('sanitizeWindowBounds off-screen recovery', () => {
  test('a window on an unplugged monitor loses its position but keeps its size', () => {
    // Saved on a second display at x=1920..3840 which is no longer attached.
    const out = run({ x: 2200, y: 100, width: 500, height: 650 });
    expect(out).toEqual({ width: 500, height: 650 });
    expect(out.x).toBeUndefined();
    expect(out.y).toBeUndefined();
  });

  test('a window fully above the work area (behind a top taskbar) is recentred', () => {
    const below: Rect = { x: 0, y: 40, width: 1920, height: 1000 };
    expect(run({ x: 100, y: -800, width: 460, height: 700 }, [below])).toEqual({
      width: 460,
      height: 700,
    });
  });

  test('a window mostly off the right edge keeps its position while a grabbable strip remains', () => {
    // Only MIN_VISIBLE_PX of the window is still on screen — exactly enough.
    const x = PRIMARY.width - MIN_VISIBLE_PX;
    expect(run({ x, y: 100, width: 460, height: 700 })).toEqual({ x, y: 100, width: 460, height: 700 });
  });

  test('one pixel less visible than the threshold drops the position', () => {
    const x = PRIMARY.width - (MIN_VISIBLE_PX - 1);
    expect(run({ x, y: 100, width: 460, height: 700 })).toEqual({ width: 460, height: 700 });
  });

  test('visibility must hold on both axes, not either one', () => {
    // Wide overlap horizontally, but the window sits entirely below the display.
    expect(run({ x: 100, y: PRIMARY.height + 5, width: 460, height: 700 })).toEqual({
      width: 460,
      height: 700,
    });
  });

  test('a position on a secondary display survives when that display is present', () => {
    const secondary: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };
    expect(run({ x: 2200, y: 100, width: 460, height: 700 }, [PRIMARY, secondary])).toEqual({
      x: 2200,
      y: 100,
      width: 460,
      height: 700,
    });
  });

  test('a display at negative coordinates (left of primary) counts', () => {
    // Windows places displays left of the primary at negative x.
    const left: Rect = { x: -1920, y: 0, width: 1920, height: 1040 };
    expect(run({ x: -1500, y: 100, width: 460, height: 700 }, [PRIMARY, left])).toEqual({
      x: -1500,
      y: 100,
      width: 460,
      height: 700,
    });
  });

  test('no displays at all falls back to size only', () => {
    // Defensive: screen.getAllDisplays() should never be empty, but the
    // contract must not divide by it being non-empty.
    expect(run({ x: 100, y: 100, width: 460, height: 700 }, [])).toEqual({ width: 460, height: 700 });
  });

  test('visibility is judged with the clamped size, not the saved size', () => {
    // Saved 1x1 at the bottom-right corner: after clamping to the minimum size
    // the window spills past the corner but MIN_VISIBLE_PX of it is on screen,
    // so the position survives.
    const x = PRIMARY.width - MIN_VISIBLE_PX;
    const y = PRIMARY.height - MIN_VISIBLE_PX;
    expect(run({ x, y, width: 1, height: 1 })).toEqual({ x, y, width: MIN.width, height: MIN.height });
  });

  test('zero and negative saved sizes clamp up to the window minimum', () => {
    // Finite garbage (a corrupt or hand-edited save) must clamp like any other
    // undersized value — a 0x0 or negative-sized BrowserWindow is unusable.
    expect(run({ x: 100, y: 100, width: 0, height: 0 })).toEqual({
      x: 100,
      y: 100,
      width: MIN.width,
      height: MIN.height,
    });
    expect(run({ x: 100, y: 100, width: -300, height: -50 })).toEqual({
      x: 100,
      y: 100,
      width: MIN.width,
      height: MIN.height,
    });
  });

  test('a window straddling two adjacent displays keeps its position via the second', () => {
    const secondary: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };
    // Only 20px remains on the primary — not grabbable there — but the bulk of
    // the window sits on the secondary. `some()` must let any one display keep it.
    expect(run({ x: 1900, y: 100, width: 460, height: 700 }, [PRIMARY, secondary])).toEqual({
      x: 1900,
      y: 100,
      width: 460,
      height: 700,
    });
  });

  test('slivers on different displays do not add up — one display must show enough on both axes', () => {
    // 30px column on the primary (x fails there) and wide x-overlap with a
    // display offset far downward (y fails there). Blending the primary's y
    // with the other display's x would wrongly call this visible.
    const lower: Rect = { x: 1920, y: 900, width: 1920, height: 1040 };
    expect(run({ x: 1890, y: 100, width: 460, height: 700 }, [PRIMARY, lower])).toEqual({
      width: 460,
      height: 700,
    });
  });

  test('exactly MIN_VISIBLE_PX on both axes at the bottom-right corner keeps the position', () => {
    // The single-axis threshold tests pin each edge; the corner pins the AND of
    // the two axes at the boundary, where an off-by-one on either would flip it.
    const x = PRIMARY.width - MIN_VISIBLE_PX;
    const y = PRIMARY.height - MIN_VISIBLE_PX;
    expect(run({ x, y, width: 460, height: 700 })).toEqual({ x, y, width: 460, height: 700 });
  });
});
