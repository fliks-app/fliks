/**
 * Closed catalogue of `media.season.actions` actionIds core implements. A plugin's
 * contribution to this slot may only reference one of these — it never ships
 * its own handler (per the plan's "no plugin ships Angular" rule).
 */
export type CoreSeasonActionId = 'season.search-releases' | 'season.grab-best';

const CORE_SEASON_ACTION_IDS: ReadonlySet<string> = new Set<CoreSeasonActionId>([
  'season.search-releases',
  'season.grab-best',
]);

/** One concrete handler per core actionId, supplied by whatever component owns the click. */
export type SeasonActionHandlers = Record<CoreSeasonActionId, () => void>;

/**
 * Resolves a contribution's `actionId` to the handler that implements it.
 * Anything outside the closed catalogue — a typo, a future id, a plugin
 * guessing — returns `null`. Fail closed: the caller must render no row at
 * all, never a button whose click silently does nothing.
 */
export function resolveSeasonAction(
  actionId: string,
  handlers: SeasonActionHandlers,
): (() => void) | null {
  return CORE_SEASON_ACTION_IDS.has(actionId) ? handlers[actionId as CoreSeasonActionId] : null;
}
