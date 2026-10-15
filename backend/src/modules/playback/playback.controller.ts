import {
  Controller,
  Put,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  ParseIntPipe,
  HttpCode,
  Logger,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { SessionTokenGuard } from '../auth/guards/session-token.guard';
import { PlaybackService } from './playback.service';
import { User } from '../users/entities/user.entity';
import {
  LiveSessionRegistry,
  type LiveSession,
  type PlaybackState as LivePlaybackState,
} from '../streaming/live-session.service';
import { EventsService, type RemoteQualityRung } from '../scheduler/events.service';
import { QoeService } from '../qoe/qoe.service';
import { EngineError, EngineService } from '../engine/engine.service';
import { restorePresence } from '../streaming/services/engine-presence';
import { servedRungBitrate } from '../streaming/served-rung';
import { parseEvents, parsePlaybackId, parseSample, parseSentAt } from '../qoe/core/validate';

/** Debounce window for DB writes — heartbeat fires every 10 s but we
 *  flush playback state on a coarser cadence to avoid hammering
 *  `playback_states` on a busy household. State transitions, the
 *  "completed" threshold and a seek short-circuit the debounce. */
const STATE_DB_WRITE_INTERVAL_MS = 30_000;

@Controller('playback')
@UseGuards(JwtOrApiKeyGuard)
export class PlaybackController {
  private readonly log = new Logger(PlaybackController.name);

  /** When the last DB write happened, and at which position, per
   *  `(userId, mediaId, episodeId)` tuple. Drives the debounce above.
   *  In-memory map — moves to a shared store the day Fliks runs across
   *  multiple backend instances. */
  private readonly lastDbWriteAt = new Map<string, { at: number; pos: number }>();

  constructor(
    private readonly playbackService: PlaybackService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly events: EventsService,
    private readonly qoe: QoeService,
    @Optional() private readonly engine?: EngineService,
  ) {}

  /** Update playback state (position, duration, file). Doubles as the
   *  live-session heartbeat when the client includes `sessionId` —
   *  refreshes the in-memory {@link LiveSessionRegistry} on every call
   *  and debounces the actual DB write to one every
   *  {@link STATE_DB_WRITE_INTERVAL_MS}. State transitions
   *  (`playing` ↔ `paused`) and completion always force a flush.
   *
   *  When the carried `sessionId` is unknown to the registry (backend
   *  restart, GC after a long idle, …) the response carries
   *  `{ sessionLost: true }` so the client knows to recover by
   *  re-issuing `playback-info` and reloading the stream URL with
   *  the fresh sid. */
  @Put('media/:mediaId/state')
  @UseGuards(SessionTokenGuard)
  async updateState(
    @Req() req: Request,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Body()
    body: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
      // Optional heartbeat fields — present once the client embeds the
      // sessionId emitted by `playback-info`.
      sessionId?: string;
      state?: LivePlaybackState;
      quality?: string | null;
      qualities?: RemoteQualityRung[] | null;
      autoplayBlocked?: boolean;
      hasNext?: boolean;
      episodeLabel?: string | null;
      supportsVolume?: boolean;
      subtitleId?: string | null;
      audioTrackIndex?: number | null;
      subtitleTrackIndex?: number | null;
      sseConnectionId?: string;
      // Set by a client with no SSE primitive (the native TV app): lets its
      // heartbeat resolve to a remote-control target the same way an SSE
      // connection id does. See EventsService.targetIdFor.
      targetId?: string;
      volume?: number;
      muted?: boolean;
      lastCmdId?: string;
      qoe?: unknown;
    },
  ): Promise<{ sessionLost?: true; state?: unknown } | null> {
    const user = req.user as User;
    const sseConnectionId =
      body.sseConnectionId ??
      req.get('x-fliks-sse-connection') ??
      (body.targetId ? `polled:${body.targetId}` : undefined);

    let stateChanged = false;
    let sessionLost = false;
    // Declared out here on purpose: `updated` is scoped to the block below, and
    // the history write happens after it.
    let attributedUserId: number | null = null;
    let engineLost: boolean | undefined;
    if (body.sessionId) {
      if (this.engine?.runtime) {
        engineLost = await this.engineBeat(user, body.sessionId, body);
      }
      const before = this.liveSessions.peek(body.sessionId);
      const previousState = before?.state;
      const updated = engineLost
        ? null
        : this.liveSessions.heartbeat(body.sessionId, {
        position: body.positionSeconds,
        state: body.state,
        quality: body.quality,
        qualities: body.qualities,
        autoplayBlocked: body.autoplayBlocked,
        hasNext: body.hasNext,
        episodeLabel: body.episodeLabel,
        supportsVolume: body.supportsVolume,
        subtitleId: body.subtitleId,
        audioTrackIndex: body.audioTrackIndex,
        subtitleTrackIndex: body.subtitleTrackIndex,
        sseConnectionId,
        volume: body.volume,
        muted: body.muted,
      });
      attributedUserId = updated?.attributedUserId ?? null;
      stateChanged = !!updated && !!body.state && previousState !== body.state;
      // The client believes the session is alive but the registry
      // doesn't know it — surface that so the client can recover.
      sessionLost = engineLost ?? !updated;
      if (updated && body.qoe != null && (updated.userId === user.id || updated.attributedUserId === user.id)) {
        const sample = parseSample(body.qoe);
        if (sample) {
          sample.variantBitrate ??= servedRungBitrate(updated);
          this.qoe.recordSample(updated, sample);
          const rung = servedRungBitrate(updated);
          if (rung != null && typeof updated.quality === 'string' && updated.quality !== 'auto' && updated.quality.length <= 32) {
            this.qoe.updatePipelineOutput(updated, updated.quality, rung);
          }
        }
      }

      // Remote-control fan-out: must fire on every heartbeat, not just a DB
      // flush, so it stays inside this block rather than after it.
      if (updated) {
        // Stored connection id, not the request header: the client drops
        // that header for the whole SSE reconnect backoff window.
        const targetId = this.events.targetIdFor(updated.sseConnectionId);
        if (targetId) {
          this.events.emitToUser(user.id, {
            type: 'remote.state',
            targetId,
            sessionId: body.sessionId,
            mediaId,
            mediaFileId: body.mediaFileId,
            episodeId: body.episodeId ?? null,
            mediaTitle: updated.mediaTitle,
            episodeLabel: updated.episodeLabel,
            posterUrl: updated.posterUrl,
            fanartUrl: updated.fanartUrl,
            positionSeconds: updated.position,
            durationSeconds: body.durationSeconds,
            state: updated.state,
            volume: updated.volume,
            muted: updated.muted,
            supportsVolume: updated.supportsVolume,
            subtitleId: updated.subtitleId,
            quality: updated.quality,
            qualities: updated.qualities,
            autoplayBlocked: updated.autoplayBlocked,
            hasNext: updated.hasNext,
            audioTrackIndex: updated.audioTrackIndex,
            subtitleTrackIndex: updated.subtitleTrackIndex,
            lastCmdId: body.lastCmdId ?? null,
          });
        } else {
          this.log.debug(
            `Skipping remote.state for session ${body.sessionId}: no live target for connection ${updated.sseConnectionId ?? 'null'}`,
          );
        }
      }
    }

    // A playback launched here by remote control counts for whoever launched it,
    // the way a cast session counts for the phone that started it. The device
    // keeps its own login: only the history moves.
    const historyUserId = attributedUserId ?? user.id;
    const dbKey = `${historyUserId}:${mediaId}:${body.episodeId ?? 0}`;
    const now = Date.now();
    const last = this.lastDbWriteAt.get(dbKey);
    const dur = body.durationSeconds ?? 0;
    const pos = body.positionSeconds ?? 0;
    const wouldCompleteRow = dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);
    // A position the debounce window can't explain by plain playback is a
    // seek: flush it now, or leaving the player right after loses the jump.
    const seeked =
      !last || Math.abs(pos - last.pos) > STATE_DB_WRITE_INTERVAL_MS / 1000;
    const shouldFlushDb =
      stateChanged ||
      wouldCompleteRow ||
      seeked ||
      now - (last?.at ?? 0) >= STATE_DB_WRITE_INTERVAL_MS;

    if (!shouldFlushDb) {
      return sessionLost ? { sessionLost: true } : null;
    }
    this.lastDbWriteAt.set(dbKey, { at: now, pos });
    // Drop debounce entries for playbacks idle past a few write intervals so
    // the map can't grow unbounded over the process lifetime — a pruned entry
    // only gated the next write, which simply re-creates it.
    const staleBefore = now - STATE_DB_WRITE_INTERVAL_MS * 10;
    for (const [key, entry] of this.lastDbWriteAt) {
      if (entry.at < staleBefore) this.lastDbWriteAt.delete(key);
    }
    const state = await this.playbackService.updateState(historyUserId, mediaId, {
      positionSeconds: body.positionSeconds,
      durationSeconds: body.durationSeconds,
      mediaFileId: body.mediaFileId,
      episodeId: body.episodeId,
    });
    if (sessionLost) return { sessionLost: true, state };
    return { state };
  }

  /** The engine's heartbeat (and the owner check the registry never made): true when it lost the
   *  session, undefined when it could not be asked, so the registry answers as before. */
  private async engineBeat(
    user: User,
    sid: string,
    body: { positionSeconds: number; state?: string; quality?: string | null },
  ): Promise<boolean | undefined> {
    const known = this.liveSessions.peek(sid);
    if (known?.userId != null && known.userId !== user.id && known.attributedUserId !== user.id) {
      throw new ForbiddenException('Not your session');
    }
    try {
      const { sessionLost } = await this.engine!.heartbeat(sid, {
        ownerId: String(known?.userId ?? user.id),
        positionS: body.positionSeconds,
        state: body.state,
        quality: body.quality ?? undefined,
      });
      if (!sessionLost && !known) {
        const snap = await this.engine!.getSession(sid);
        if (snap) restorePresence(this.liveSessions, snap);
      }
      return sessionLost;
    } catch (err) {
      if (err instanceof EngineError && err.status === 403) {
        throw new ForbiddenException('Not your session');
      }
      this.log.warn(`engine heartbeat failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Point events (stall, error, recovery, quality switch) of a live session.
   *  Silent 204 for an unknown session: a fatal error often outlives it. */
  @Post('sessions/:sessionId/events')
  @UseGuards(SessionTokenGuard)
  @HttpCode(204)
  postQoeEvents(
    @Req() req: Request,
    @Param('sessionId') sessionId: string,
    @Body() body: { events?: unknown; playbackId?: unknown; sentAt?: unknown },
  ): void {
    const user = req.user as User;
    if (!this.qoe.enabled) return;
    // The exit flush races DELETE /stream/sessions/:id, so an ended session still takes events.
    const live =
      this.liveSessions.peek(sessionId) ?? this.qoe.trackedSession(sessionId);
    if (!live) return;
    if (live.userId !== user.id && live.attributedUserId !== user.id) {
      throw new ForbiddenException('Not your session');
    }
    this.qoe.recordEvents(
      live,
      parseEvents(body?.events, Date.now(), parseSentAt(body?.sentAt)),
      parsePlaybackId(body?.playbackId),
    );
  }
}
