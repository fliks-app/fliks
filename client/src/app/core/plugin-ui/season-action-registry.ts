/** Closed catalogue of `media.season.actions` actionIds core implements; plugin contributions may only reference these, never ship a handler. */
export type CoreSeasonActionId = 'season.search-releases' | 'season.grab-best';

const CORE_SEASON_ACTION_IDS: ReadonlySet<string> = new Set<CoreSeasonActionId>([
  'season.search-releases',
  'season.grab-best',
]);

/** One concrete handler per core actionId, supplied by whatever component owns the click. */
export type SeasonActionHandlers = Record<CoreSeasonActionId, () => void>;

/** Resolves a contribution's `actionId` to its handler; anything outside the catalogue returns `null` (fail closed: render no row). */
export function resolveSeasonAction(
  actionId: string,
  handlers: SeasonActionHandlers,
): (() => void) | null {
  return CORE_SEASON_ACTION_IDS.has(actionId) ? handlers[actionId as CoreSeasonActionId] : null;
}
