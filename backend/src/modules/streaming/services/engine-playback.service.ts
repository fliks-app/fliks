import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EngineError, EngineService } from '../../engine/engine.service';
import type {
  OpenSessionRequest,
  OpenSessionResponse,
} from '../../engine/engine.service';
import { EventsService } from '../../scheduler/events.service';
import { MarkersService } from '../../markers/markers.service';
import { PlaybackService } from '../../playback/playback.service';
import { QoeService } from '../../qoe/qoe.service';
import { PluginPreRollService } from '../../plugins/plugin-pre-roll.service';
import { User } from '../../users/entities/user.entity';
import { DeviceProfileDto } from '../dto/device-profile.dto';
import type { PlaybackInfoResponse } from '../dto/playback-info.dto';
import { readEdlSidecar, shiftRanges } from '../edl/edl-sidecar';
import { LiveSessionRegistry } from '../live-session.service';
import {
  resolveAudioStreamIndex,
  resolveEffectiveStartAt,
  resolvePreRoll,
} from '../playback-info.util';
import { StreamingService, type ResolvedFile } from '../streaming.service';
import { StreamingSettingsCache } from '../streaming-settings-cache.service';
import {
  SubtitleBurnInService,
  type BurnInSubtitle,
} from '../subtitle-burn-in.service';
import { SubtitleStreamService } from '../subtitle-stream.service';
import { HostHardwareService } from '../host-hardware.service';
import { parseSourceFps } from '../../media-tools/fps';
import { presenceInput, toQoePipeline, toTags } from './engine-presence';
import { SourceScanService } from './source-scan.service';
import { StaleProbeRescanService } from './stale-probe-rescan.service';

/** The query of `POST :id/playback-info`, parsed by the controller. */
export interface PlaybackQuery {
  tokenParam: string;
  burnInSubtitleId?: number;
  audioStreamIndex?: string;
  startQuality?: string;
  startAt?: number;
  download: boolean;
  sseConnectionId: string | null;
  userAgent: string | null;
}

type Marker = { startSeconds: number; endSeconds: number };

/** The body of playback-info: the engine's decision plus what the app adds. */
export type EnginePlaybackInfo = PlaybackInfoResponse & {
  sessionId: string;
  profileHash: string | null;
  durationSeconds: number;
  markers?: { intro?: Marker; outro?: Marker };
  chapters?: { title?: string; startSeconds: number; endSeconds: number }[];
};

/** `POST :id/playback-info`: the host decides nothing, it gathers what the engine needs, opens the
 *  session and adds the app-side extras to the engine's decision. */
@Injectable()
export class EnginePlaybackService {
  private readonly log = new Logger(EnginePlaybackService.name);

  constructor(
    private readonly engine: EngineService,
    private readonly streamingService: StreamingService,
    private readonly subtitleBurnIn: SubtitleBurnInService,
    private readonly subtitleStreamService: SubtitleStreamService,
    private readonly sourceScans: SourceScanService,
    private readonly staleProbeRescan: StaleProbeRescanService,
    private readonly settingsCache: StreamingSettingsCache,
    private readonly hardware: HostHardwareService,
    private readonly markersService: MarkersService,
    private readonly playbackService: PlaybackService,
    private readonly pluginPreRoll: PluginPreRollService,
    private readonly events: EventsService,
    private readonly qoe: QoeService,
    private readonly liveSessions: LiveSessionRegistry,
  ) {}

  async playbackInfo(
    user: User,
    mediaFileId: number,
    device: DeviceProfileDto,
    q: PlaybackQuery,
  ): Promise<EnginePlaybackInfo> {
    if (this.engine.gatewayMismatch) {
      throw new ServiceUnavailableException(
        'The saved engine URL is not the one this process forwards video to',
      );
    }
    if (!this.engine.runtime) {
      if (this.engine.status === 'down') {
        throw new ServiceUnavailableException(
          'The streaming engine is unreachable',
        );
      }
      throw new ServiceUnavailableException(
        'Playback needs the streaming engine, which is not running',
      );
    }
    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    const info = resolved.mediaFile.streamInfo;
    const burnIn = await this.resolveBurnIn(q.burnInSubtitleId, mediaFileId);
    await this.hardware.apply(await this.settingsCache.get());

    const held = await this.sourceScans.lookup(
      mediaFileId,
      resolved.absolutePath,
      info,
    );
    const episodeId = resolved.mediaFile.episodeId ?? undefined;
    const position = await resolveEffectiveStartAt(
      this.playbackService,
      q.startAt,
      user.id,
      resolved.mediaFile.mediaId,
      episodeId,
    );
    const subtitleRenditions = device.supportsHlsSubtitles
      ? await this.subtitleStreamService
          .listTextSubtitleRenditions(mediaFileId, user)
          .catch(() => undefined)
      : undefined;
    // Taken before the open, the tags carry it; given back when the open fails.
    const attributionTarget = this.events.targetIdFor(q.sseConnectionId);
    const attributedUserId = this.events.takeAttribution(
      attributionTarget,
      mediaFileId,
    );
    const tags = toTags({
      username: user.username,
      mediaTitle: resolved.media?.title,
      mediaType: resolved.media?.type,
      posterUrl: resolved.media?.posterUrl,
      fanartUrl: resolved.media?.fanartUrl,
      sseConnectionId: q.sseConnectionId,
      attributedUserId,
    });
    const client = {
      deviceName: device.deviceName,
      systemName: device.systemName,
      appVersion: device.appVersion,
      userAgent: q.userAgent ?? undefined,
    };

    const open = await this.open({
      decide: {
        media: {
          mediaFileId,
          path: resolved.absolutePath,
          ext: resolved.ext,
          contentType: resolved.contentType,
        },
        info: info as never,
        scan: held.scan as never,
        device: device as never,
        selection: {
          tokenParam: q.tokenParam,
          burnInSubtitleId: burnIn ? q.burnInSubtitleId : undefined,
          burnInIsText: !!burnIn?.filter,
          requestedQuality: q.startQuality,
          audioStreamIndex: resolveAudioStreamIndex(
            q.audioStreamIndex,
            info?.audio?.length ?? 0,
          ),
        },
      },
      ownerId: String(user.id),
      client,
      tags,
      startAtS: position,
      pinned: q.download,
      burnIn: burnIn && {
        type: burnIn.type,
        filter: burnIn.filter ?? undefined,
        streamIndex: burnIn.streamIndex,
      },
      sourceVersion: held.version ?? undefined,
      subtitleRenditions,
    }).catch((err: unknown) => {
      if (attributionTarget && attributedUserId != null)
        this.events.claimAttribution(
          attributionTarget,
          attributedUserId,
          mediaFileId,
        );
      throw err;
    });
    const { response } = open.decision;
    const v0 = info?.video?.[0];

    const kind =
      response.playMethod === 'DirectPlay'
        ? 'directplay'
        : response.playMethod === 'DirectStream'
          ? 'remux'
          : 'transcode';
    const live = this.liveSessions.create(
      presenceInput({
        sessionId: open.sessionId,
        userId: user.id,
        mediaFileId,
        profileHash: open.profileHash ?? null,
        quality: q.startQuality ?? null,
        kind,
        decision: open.decision,
        client,
        tags,
        positionS: position,
      }),
    );

    this.qoe.register(live);
    if (open.qoePipeline)
      this.qoe.setPipeline(live, toQoePipeline(open.qoePipeline));

    this.rescanIf(open, mediaFileId, resolved);
    const fps = parseSourceFps(v0?.frameRate);
    const [markers, preRoll, edl] = await Promise.all([
      this.markers(episodeId),
      resolvePreRoll({
        ask: () =>
          this.pluginPreRoll.ask({
            mediaFileId,
            mediaId: resolved.mediaFile.mediaId,
            episodeId,
            principal: { kind: 'delegated', userId: user.id },
          }),
        resolveFile: (id, forUser) =>
          this.streamingService.resolveFile(id, forUser),
        user,
      }),
      user.edlEnabled === false
        ? undefined
        : readEdlSidecar(resolved.absolutePath, fps),
      !q.download && user.id && resolved.mediaFile.mediaId
        ? this.playbackService
            .markSessionStarted(
              user.id,
              resolved.mediaFile.mediaId,
              mediaFileId,
              episodeId ?? null,
            )
            .catch((err) =>
              this.log.warn(`Failed to mark session started: ${err}`),
            )
        : undefined,
    ]);

    return {
      ...(response as unknown as PlaybackInfoResponse),
      playUrl: open.playPath,
      edl: edl?.length
        ? shiftRanges(edl, open.playbackClockOffsetS ?? 0)
        : undefined,
      tonemapAlgo: open.tonemapAlgo ?? null,
      tonemapCurve: open.tonemapCurve ?? undefined,
      durationSeconds: info?.durationSeconds ?? 0,
      markers,
      chapters: info?.chapters?.length ? info.chapters : undefined,
      preRoll,
      sessionId: open.sessionId,
      profileHash: open.profileHash ?? null,
    } as EnginePlaybackInfo;
  }

  private async open(req: OpenSessionRequest): Promise<OpenSessionResponse> {
    try {
      return await this.engine.openSession(req);
    } catch (err) {
      if (err instanceof EngineError && err.status === 400)
        throw new BadRequestException(err.message);
      if (err instanceof HttpException) throw err;
      this.log.warn(`engine session not opened: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'The streaming engine is unavailable',
      );
    }
  }

  /** A subtitle that cannot be resolved plays without a burn-in. */
  private async resolveBurnIn(
    subtitleId: number | undefined,
    mediaFileId: number,
  ): Promise<BurnInSubtitle | null> {
    if (!subtitleId) return null;
    try {
      const info = await this.subtitleBurnIn.resolve(subtitleId, mediaFileId);
      return {
        filter: this.subtitleBurnIn.buildFilter(info),
        streamIndex: info.streamIndex,
        type: info.type,
      };
    } catch (err) {
      this.log.warn(
        `Burn-in resolve failed for subtitle #${subtitleId}: ${err}`,
      );
      return null;
    }
  }

  /** The engine's hints: a stale probe is re-probed (which chains the scan), else a missing scan is made. */
  private rescanIf(
    open: OpenSessionResponse,
    mediaFileId: number,
    resolved: ResolvedFile,
  ): void {
    const info = resolved.mediaFile.streamInfo;
    if (open.hints.probeStale) {
      void this.staleProbeRescan.schedule(mediaFileId, resolved.absolutePath);
    } else if (open.hints.scanMissing) {
      void this.sourceScans.scheduleIfNeeded(
        mediaFileId,
        resolved.absolutePath,
        info,
        'high',
      );
    }
  }

  private async markers(episodeId: number | undefined) {
    if (!episodeId) return undefined;
    const [intro, outro] = await Promise.all([
      this.markersService.findIntroForEpisode(episodeId),
      this.markersService.findOutroForEpisode(episodeId),
    ]);
    const range = (m: Marker | null) =>
      m
        ? { startSeconds: m.startSeconds, endSeconds: m.endSeconds }
        : undefined;
    return intro || outro
      ? { intro: range(intro), outro: range(outro) }
      : undefined;
  }
}
