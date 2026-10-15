import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { Action } from '../auth/casl/actions.enum';
import { EventsService } from '../scheduler/events.service';
import { User } from '../users/entities/user.entity';
import { EngineService } from '../engine/engine.service';
import { availableParallelism } from 'os';
import { parseSourceFps } from '../media-tools/fps';
import type { EdlRange } from './edl/edl-parser';
import { readEdlSidecar } from './edl/edl-sidecar';
import { DeviceProfileDto } from './dto/device-profile.dto';
import { HostHardwareService } from './host-hardware.service';
import { LiveSessionRegistry } from './live-session.service';
import { EnginePlaybackService } from './services/engine-playback.service';
import { StreamingService } from './streaming.service';
import { StreamingSettingsCache } from './streaming-settings-cache.service';

export { resolveAudioStreamIndex, resolvePreRoll } from './playback-info.util';

function firstQueryString(
  query: Request['query'],
  key: string,
): string | undefined {
  const v = query[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/** `?token=…&sid=…` of the request, carried into the URLs the engine hands back. */
function buildTokenParam(req: Request): string {
  const parts: string[] = [];
  for (const key of ['token', 'sid']) {
    const v = firstQueryString(req.query, key);
    if (v) parts.push(`${key}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** The control plane of `/api/stream`; the engine serves every byte route (`GET :id/**`). */
@Controller('stream')
@UseGuards(JwtOrApiKeyGuard)
export class StreamingController {
  private readonly log = new Logger(StreamingController.name);

  constructor(
    private readonly streamingService: StreamingService,
    private readonly hardware: HostHardwareService,
    private readonly streamingSettingsCache: StreamingSettingsCache,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly events: EventsService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
    private readonly engine: EngineService,
    private readonly enginePlayback: EnginePlaybackService,
  ) {}

  /** Available download qualities for a media file (used by download-quality modal). */
  @Get('info/qualities/:mediaFileId')
  async downloadQualities(
    @Req() req: Request,
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
  ) {
    const resolved = await this.streamingService.resolveFile(
      mediaFileId,
      req.user as User,
    );
    return this.engine.estimateSizes(
      resolved.mediaFile.streamInfo,
      resolved.size,
    );
  }

  @Get('info/hw-accel')
  hwAccelInfo() {
    return { hwAccel: this.hardware.hwAccel };
  }

  /** Tone-map algorithms this host can run, for the admin dropdown; `'auto'` is always there. */
  @Get('info/tonemap-algos')
  tonemapAlgosInfo() {
    return { available: this.hardware.tonemapAlgos };
  }

  /** What the admin streaming form pre-fills: the saved setting, else what the env/host resolve to. */
  @Get('info/effective-settings')
  async effectiveSettingsInfo() {
    const ss = await this.streamingSettingsCache.get();
    return {
      tonemapAlgo: ss.tonemapAlgo,
      gpuRenderNode: ss.gpuRenderNode,
      tonemapCurve: ss.tonemapCurve,
      cacheMaxGb: +(ss.cacheMaxBytes / 1024 ** 3).toFixed(1),
      cacheTtlHours: +(ss.cacheTtlMs / 3_600_000).toFixed(1),
      ffmpegSlots: ss.ffmpegSlots,
      // The engine's default (cores - 1); it does not report the figure.
      ffmpegSlotsAuto: Math.max(1, availableParallelism() - 1),
      pauseCapability: this.hardware.pauseCapability,
    };
  }

  /** Detected GPUs for the admin device picker; an empty list hides it. */
  @Get('info/gpus')
  gpusInfo() {
    return this.hardware.gpus();
  }

  /** The client sends its DeviceProfile, the engine decides how to play the file. */
  @Post(':mediaFileId/playback-info')
  playbackInfo(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Body() deviceProfile: DeviceProfileDto,
    @Req() req: Request,
  ) {
    const burnIn = firstQueryString(req.query, 'burnInSubtitleId');
    const startAt = firstQueryString(req.query, 'startAt');
    return this.enginePlayback.playbackInfo(
      req.user as User,
      mediaFileId,
      deviceProfile,
      {
        tokenParam: buildTokenParam(req),
        burnInSubtitleId: burnIn ? parseInt(burnIn, 10) : undefined,
        audioStreamIndex: firstQueryString(req.query, 'audioStreamIndex'),
        startQuality: firstQueryString(req.query, 'startQuality'),
        startAt: startAt != null ? parseFloat(startAt) : undefined,
        download: firstQueryString(req.query, 'download') === '1',
        sseConnectionId: req.get('x-fliks-sse-connection') ?? null,
        userAgent: req.get('user-agent') ?? null,
      },
    );
  }

  /** Owner of a session the host has no presence for but the engine still holds. */
  private async engineOwnerOf(sessionId: string): Promise<number | null> {
    if (!this.engine.runtime) return null;
    const owner = Number(
      (await this.engine.getSession(sessionId).catch(() => null))?.ownerId,
    );
    return Number.isInteger(owner) ? owner : null;
  }

  /** `.edl` sidecar ranges on the container timeline (DirectPlay clock), for original-file downloads. */
  @Get(':mediaFileId/edl')
  async edl(
    @Param('mediaFileId', ParseIntPipe) mediaFileId: number,
    @Req() req: Request,
  ): Promise<{ ranges: EdlRange[] }> {
    const user = req.user as User;
    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    if (user.edlEnabled === false) return { ranges: [] };
    const fps = parseSourceFps(
      resolved.mediaFile.streamInfo?.video?.[0]?.frameRate,
    );
    return {
      ranges: (await readEdlSidecar(resolved.absolutePath, fps)) ?? [],
    };
  }

  /**
   * Explicit stop from the client (player destroy / page unload, `keepalive`): ends the presence
   * and the engine session. Idempotent: 204 on an unknown sid.
   */
  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async stopLiveSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: User | undefined,
  ) {
    const live = this.liveSessions.peek(sessionId);
    const ownerId = live ? live.userId : await this.engineOwnerOf(sessionId);

    // Sids travel in HLS URLs, so a bare ownership-blind stop would let any
    // authenticated user end anyone else's playback.
    if (ownerId != null && ownerId !== user?.id) {
      const allowed =
        !!user &&
        this.caslAbilityFactory
          .createForUser(user)
          .can(Action.Manage, 'Settings');
      if (!allowed) {
        this.log.warn(
          `Refused: user ${user?.id ?? 'unknown'} tried to stop session ${sessionId} owned by user ${ownerId}`,
        );
        throw new ForbiddenException('Not your session');
      }
    }

    if (live?.userId != null) {
      const stoppedTargetId = this.events.targetIdFor(live.sseConnectionId);
      if (stoppedTargetId) {
        this.events.emitToUser(live.userId, {
          type: 'remote.stopped',
          targetId: stoppedTargetId,
        });
      } else {
        this.log.debug(
          `stopLiveSession(${sessionId}): no live target for connection ` +
            `${live.sseConnectionId ?? 'null'}, no stop announced`,
        );
      }
      this.events.emitToUser(live.userId, { type: 'remote.targets_changed' });
    }

    this.liveSessions.stop(sessionId);
    if (!this.engine.runtime) return;
    await this.engine
      .deleteSession(sessionId)
      .catch((err: Error) =>
        this.log.warn(
          `engine session ${sessionId} not deleted: ${err.message}`,
        ),
      );
  }
}
