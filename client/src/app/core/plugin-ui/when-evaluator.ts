import type { MediaType } from '../enums/media-type.enum';

/**
 * Everything a `when` predicate can read. Deliberately narrow — this is not
 * app state, just the handful of facts the closed vocabulary needs.
 */
export interface WhenContext {
  isAdmin: boolean;
  hasPermission: (permission: string) => boolean;
  mediaType?: MediaType;
  hasFiles?: boolean;
  isMonitored?: boolean;
  hasQualityProfile?: boolean;
  isEpisode?: boolean;
  isTv: boolean;
  isTouch: boolean;
  /** Which menu is being built. Both surfaces read the same contribution
   *  lists, so an item only declares this when it genuinely belongs to one:
   *  Play and Open mean nothing on a detail page you are already on. */
  surface?: 'card' | 'detail';
}

/** `null` marks a predicate this client doesn't know — the fail-closed signal. */
function evaluateKnown(predicate: string, ctx: WhenContext): boolean | null {
  if (predicate === 'isAdmin') return ctx.isAdmin;
  if (predicate.startsWith('hasPermission:')) {
    return ctx.hasPermission(predicate.slice('hasPermission:'.length));
  }
  if (predicate === 'mediaType:movie') return ctx.mediaType === 'movie';
  if (predicate === 'mediaType:series') return ctx.mediaType === 'series';
  if (predicate === 'hasFiles') return ctx.hasFiles ?? false;
  if (predicate === 'isMonitored') return ctx.isMonitored ?? false;
  if (predicate === 'hasQualityProfile') return ctx.hasQualityProfile ?? false;
  if (predicate === 'isEpisode') return ctx.isEpisode ?? false;
  if (predicate === 'isTv') return ctx.isTv;
  if (predicate === 'isTouch') return ctx.isTouch;
  if (predicate === 'surface:card') return ctx.surface === 'card';
  if (predicate === 'surface:detail') return ctx.surface === 'detail';
  return null;
}

/**
 * One `when` entry. A leading "!" negates — but an unknown predicate stays
 * false even negated, because negating "unknown" is still unknown.
 */
function evaluateOne(predicate: string, ctx: WhenContext): boolean {
  const negated = predicate.startsWith('!');
  const result = evaluateKnown(negated ? predicate.slice(1) : predicate, ctx);
  if (result === null) return false;
  return negated ? !result : result;
}

/**
 * `when` is presentation only: it decides what the client shows, never what
 * the server allows. Every action behind a contribution is CASL-guarded
 * server-side regardless of how this evaluates.
 */
export function evaluateWhen(when: readonly string[] | undefined, ctx: WhenContext): boolean {
  return (when ?? []).every((predicate) => evaluateOne(predicate, ctx));
}
