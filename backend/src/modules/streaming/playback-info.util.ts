import type { PreRollItem } from '../../common/plugin-contract';
import type { PlaybackService } from '../playback/playback.service';

/** The requested audio track if the file has it, else undefined (first track). */
export function resolveAudioStreamIndex(
  raw: string | undefined,
  audioCount: number,
): number | undefined {
  const index = raw != null ? Number(raw) : NaN;
  return Number.isInteger(index) && index >= 0 && index < audioCount
    ? index
    : undefined;
}

/**
 * Asks the plugin, then ACL-gates every candidate through the same `resolveFile` the main item
 * uses, for the same user: a plugin only names an id, it never grants access to one. Answers
 * `undefined` rather than `[]` so a plugin-free install serializes with `preRoll` absent.
 */
export async function resolvePreRoll<TUser>(deps: {
  ask: () => Promise<PreRollItem[]>;
  resolveFile: (mediaFileId: number, user: TUser) => Promise<unknown>;
  user: TUser;
}): Promise<PreRollItem[] | undefined> {
  const candidates = await deps.ask();
  if (!candidates.length) return undefined;
  const checks = await Promise.allSettled(
    candidates.map((c) => deps.resolveFile(c.mediaFileId, deps.user)),
  );
  const allowed = candidates.filter((_, i) => checks[i].status === 'fulfilled');
  return allowed.length ? allowed : undefined;
}

/**
 * Effective resume offset in seconds. The explicit `startAt` query wins when supplied (including
 * `0` = restart from the top); otherwise the saved position when it is a meaningful resume
 * (>10 s in, not finished), else 0.
 */
export async function resolveEffectiveStartAt(
  playback: Pick<PlaybackService, 'getState'>,
  startAt: number | undefined,
  userId: number | undefined,
  mediaId: number | undefined,
  episodeId: number | undefined,
): Promise<number> {
  if (startAt !== undefined) return startAt;
  if (userId != null && mediaId != null) {
    const state = await playback.getState(userId, mediaId, episodeId);
    if (state && !state.completed && state.positionSeconds > 10) {
      return state.positionSeconds;
    }
  }
  return 0;
}
