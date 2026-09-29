// Pure window-geometry sanitization for restoring persisted bounds. No
// Electron imports, so it is unit-testable — main.ts feeds it the saved bounds
// and the live display work areas.

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How much of the window must land on a live display, per axis, for the saved
 * position to be trusted. Big enough to guarantee a grabbable title bar; small
 * enough that a window docked mostly off one edge still comes back where the
 * user left it.
 */
export const MIN_VISIBLE_PX = 40;

/**
 * Turn persisted window bounds into safe BrowserWindow options.
 *
 * The size is clamped to the window's minimum. The position survives only if
 * at least MIN_VISIBLE_PX of the window intersects some display's work area on
 * both axes — a monitor that was unplugged since last run must not strand the
 * window where no mouse can reach it. When the position is dropped (or nothing
 * was saved), only a size is returned and Electron centers the window.
 */
export function sanitizeWindowBounds(
  saved: WindowBounds | undefined,
  workAreas: Rect[],
  defaults: { width: number; height: number },
  min: { width: number; height: number },
): { x?: number; y?: number; width: number; height: number } {
  if (
    !saved ||
    !Number.isFinite(saved.x) ||
    !Number.isFinite(saved.y) ||
    !Number.isFinite(saved.width) ||
    !Number.isFinite(saved.height)
  ) {
    return { ...defaults };
  }
  const width = Math.max(min.width, Math.round(saved.width));
  const height = Math.max(min.height, Math.round(saved.height));
  const x = Math.round(saved.x);
  const y = Math.round(saved.y);
  const visible = workAreas.some((wa) => {
    const overlapX = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x);
    const overlapY = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });
  if (!visible) return { width, height };
  return { x, y, width, height };
}
