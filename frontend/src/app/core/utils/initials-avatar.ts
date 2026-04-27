/**
 * Derives a deterministic { initials, hue } pair from a string. Used as a
 * fallback when a user (or anything else with a name) has no real avatar —
 * we render the initials on a colored circle whose hue is hashed from the
 * name so the same user always gets the same color.
 */
export function initialsAvatar(name: string): { initials: string; hue: number } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { initials: '?', hue: 0 };
  // Initials = first 1-2 letters of the first 1-2 whitespace-separated parts.
  const parts = trimmed.split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = parts.map((p) => p[0]).join('').toUpperCase();
  // FNV-1a hash → hue in 0..359. Cheap, stable, no crypto needed.
  let h = 2166136261;
  for (let i = 0; i < trimmed.length; i++) {
    h ^= trimmed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return { initials: initials || '?', hue };
}
