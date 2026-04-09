/** Format seconds to h:mm:ss or m:ss. */
export function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Calculate drag time from a pointer event on a progress bar. */
export function calcDragTime(e: PointerEvent, bar: HTMLElement, duration: number): number {
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return ratio * (duration || 0);
}

export interface SpriteMetadata {
  interval: number;
  columns: number;
  thumbWidth: number;
  thumbHeight: number;
  count: number;
}

/** Calculate hover percent from a pointer event on a progress bar. */
export function calcHoverPercent(e: PointerEvent, bar: HTMLElement): number {
  const rect = bar.getBoundingClientRect();
  return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
}

/** Parse audio stream index from track ID (e.g., 'audio-2' → 2). */
export function parseAudioIndex(trackId: string): number {
  return parseInt(trackId.replace(/^(si-|shaka-|audio-)/, ''), 10);
}
