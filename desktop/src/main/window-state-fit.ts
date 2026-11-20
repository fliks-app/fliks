export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window this much inside a display can still be grabbed by its title bar. */
const MIN_VISIBLE_W = 200;
const MIN_VISIBLE_H = 100;

export function parseWindowState(v: unknown): WindowState | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const nums = ['x', 'y', 'width', 'height'].map((k) => o[k]);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const [x, y, width, height] = nums as number[];
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, maximized: o.maximized === true, fullscreen: o.fullscreen === true };
}

/** The bounds themselves when some display shows enough of them, else null (the caller falls back to the default placement). */
export function fitToDisplays(b: Rect, workAreas: Rect[]): Rect | null {
  const shown = workAreas.some((a) => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w >= MIN_VISIBLE_W && h >= MIN_VISIBLE_H;
  });
  return shown ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}
