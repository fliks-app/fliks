/**
 * Stands in for a channel's provider category when an entry carries none: a
 * null/empty group is otherwise invisible to every group-scoped list, count
 * and restriction. The shape (snake case, double-underscored) can't collide
 * with a provider `group-title`/`category_name`, which is always human-typed
 * prose, and doubles as the key the client looks up to show a translated label.
 */
export const UNGROUPED_SENTINEL = '__livetv_ungrouped__';

/** Ingestion-time normalisation: trims the edge whitespace IPTV playlists
 *  routinely carry, and replaces an absent group with the sentinel so it can
 *  be listed, counted and restricted like any other. */
export function normalizeGroupName(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed || UNGROUPED_SENTINEL;
}
