import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TranscodingService, VARIANT_EARLY, VARIANT_MAIN, remuxVariant } from '../transcoding';
import type { TranscodeSession } from '../transcoding/types';
import { LiveSession, LiveSessionRegistry } from '../live-session.service';
import { SessionExpiredException } from '../session-expired.exception';
import { User } from '../../users/entities/user.entity';

/**
 * Routes a streaming request to the transcode session / LiveSession it belongs
 * to, and 410-gates a stale `?sid=`. Manifest URLs bake in `?sid=` so segment
 * fetches reach the exact ffmpeg even when one user watches the same file on
 * several devices with different profiles; this is the single place that
 * resolution and the freshness gate live.
 */
@Injectable()
export class SessionRouter {
  constructor(
    private readonly liveSessions: LiveSessionRegistry,
    private readonly transcodingService: TranscodingService,
  ) {}

  private sidOf(req: Request): string | undefined {
    const v = req.query['sid'];
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return undefined;
  }

  /** Resolve the exact `(file, user, profileHash, variant)` session for a
   *  sid; MRU fallback only with no sid at all, never on a miss (a sibling
   *  instance, e.g. another tab, could own the MRU slot instead). */
  resolveSession(
    mediaFileId: number,
    userId: number | undefined,
    req: Request,
  ): TranscodeSession | undefined {
    const sid = this.sidOf(req);
    if (!sid) return this.transcodingService.findCurrentSession(mediaFileId, userId);
    const live = this.liveSessions.get(sid);
    if (!live || !live.profileHash) return undefined;
    // The remux key carries a `-remux[-aN][-u]` suffix (variant.ts); the
    // bare profileHash the default main variant looks up never matches it.
    const variant =
      live.kind === 'remux'
        ? remuxVariant({
            audioIndex: live.audioStreamIndex ?? undefined,
            keyframeGrid: live.remuxGrid != null,
            multiAudio: live.useExtXMedia,
          })
        : VARIANT_MAIN;
    return this.transcodingService.getExistingSession(
      mediaFileId,
      userId,
      live.profileHash,
      variant,
    );
  }

  /** Same routing as {@link resolveSession} for the early-segment companion —
   *  the base profile hash is the same; only the variant differs. */
  resolveEarlySession(
    mediaFileId: number,
    userId: number | undefined,
    req: Request,
  ): TranscodeSession | undefined {
    const sid = this.sidOf(req);
    if (sid) {
      const live = this.liveSessions.get(sid);
      if (live && live.profileHash) {
        const exact = this.transcodingService.getExistingSession(
          mediaFileId,
          userId,
          live.profileHash,
          VARIANT_EARLY,
        );
        if (exact) return exact;
      }
    }
    return this.transcodingService.findCurrentEarlySession(mediaFileId, userId);
  }

  /** Resolve the LiveSession a request belongs to: `?sid=` first, else the
   *  most-recently-active session for `(user, file)`. Null when nothing matches
   *  — caller falls back to safe defaults. */
  findRequestSession(req: Request, mediaFileId: number): LiveSession | null {
    const sid = this.sidOf(req);
    if (sid) {
      const direct = this.liveSessions.get(sid);
      if (direct) return direct;
    }
    const userId = (req.user as User | undefined)?.id;
    if (userId == null) return null;
    return this.liveSessions.findCurrent(userId, mediaFileId);
  }

  /** 410-gate HLS routes against a stale `?sid=`: when the URL carries a sid the
   *  registry no longer knows (backend restart / long-idle GC), refuse with a
   *  typed body the player recovery flow pattern-matches (`session_expired`).
   *  Without a sid the request passes (direct-URL fetches fall back to
   *  the userId lookup downstream). The touch also keeps an actively-playing
   *  session warm — segments pulled off these routes refresh the ttl without a
   *  separate heartbeat. */
  assertFresh(req: Request): void {
    const sid = this.sidOf(req);
    if (!sid) return;
    if (!this.liveSessions.touch(sid)) {
      throw new SessionExpiredException(sid);
    }
  }
}
