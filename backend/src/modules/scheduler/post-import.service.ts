import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { existsSync } from 'fs';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { EventsService } from './events.service';
import {
  ThumbnailService,
  buildSpriteLabel,
  type SpriteMetadata,
} from '../streaming/thumbnail.service';
import { MarkersService } from '../markers/markers.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Derived artefacts every newly landed file needs before playback: seek
 * sprites and intro/outro markers. Driven by events so plugin downloads,
 * disk imports and rescans all reach it through the same path.
 */
@Injectable()
export class PostImportService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PostImportService.name);
  private readonly subs = new Subscription();

  /** An import wave lands file by file — wait for it to settle so a season
   *  pack costs one marker scan instead of one per episode. */
  static readonly SETTLE_MS = 60_000;
  private readonly pending = new Map<number, NodeJS.Timeout>();

  constructor(
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
    @InjectRepository(Episode)
    private readonly episodeRepo: Repository<Episode>,
    private readonly events: EventsService,
    private readonly thumbnails: ThumbnailService,
    private readonly markers: MarkersService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.subs.add(
      this.events.onDomain((event) => {
        if (event.type === 'media.files.imported') this.schedule(event.mediaId);
      }),
    );
    this.subs.add(
      this.events.subscribe((event) => {
        if (event.type === 'rescan.completed' && event.added > 0) {
          this.schedule(event.mediaId);
        }
      }),
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.subs.unsubscribe();
  }

  private schedule(mediaId: number): void {
    const queued = this.pending.get(mediaId);
    if (queued) clearTimeout(queued);
    this.pending.set(
      mediaId,
      setTimeout(() => {
        this.pending.delete(mediaId);
        void this.run(mediaId);
      }, PostImportService.SETTLE_MS),
    );
  }

  /** Sprites first: they are per-file and cheap next to a season-wide
   *  fingerprint pass, and both compete for the same ffmpeg budget. */
  private async run(mediaId: number): Promise<void> {
    if (await this.enabled('sprites_auto_generate_on_import')) {
      try {
        const generated = await this.generateMissingSprites(mediaId);
        if (generated) {
          this.log.log(
            `Post-import[media #${mediaId}]: generated ${generated} sprite(s)`,
          );
        }
      } catch (err) {
        this.log.warn(
          `Post-import[media #${mediaId}]: sprite generation failed — ${(err as Error).message}`,
        );
      }
    }
    try {
      await this.markers.autoDetectMissing(mediaId);
    } catch (err) {
      this.log.warn(
        `Post-import[media #${mediaId}]: marker detection failed — ${(err as Error).message}`,
      );
    }
  }

  /** Both automation toggles default to on when the key was never written. */
  private async enabled(key: string): Promise<boolean> {
    return ((await this.settings.get(key)) ?? 'true') === 'true';
  }

  /**
   * Sprites are tracked as progress rather than `Command` rows: the table is
   * never pruned, and a first library import would leave one row per file.
   */
  private async generateMissingSprites(mediaId: number): Promise<number> {
    const files = await this.mediaFileRepo.find({
      where: { media: { id: mediaId } },
      select: { id: true },
    });
    const missing = files.filter(
      ({ id }) => !existsSync(this.thumbnails.getMetadataPath(id)),
    );
    if (!missing.length) return 0;

    const command = `GenerateMissingSprites:${mediaId}`;
    let generated = 0;
    for (const [index, { id }] of missing.entries()) {
      this.events.emit({
        type: 'task.progress',
        command,
        current: index,
        total: missing.length,
        message: `#${id}`,
      });
      if (await this.generateSprite(id, false)) generated++;
    }
    this.events.emit({
      type: 'task.progress',
      command,
      current: missing.length,
      total: missing.length,
      message: command,
    });
    return generated;
  }

  /**
   * Resolve the file's absolute path + sprite label from its own rows and
   * queue generation. Shared with the bulk scheduler commands.
   */
  async generateSprite(
    mediaFileId: number,
    force: boolean,
  ): Promise<SpriteMetadata | null> {
    const file = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
      relations: ['media'],
    });
    if (!file?.media) return null;

    let label = file.media.title;
    if (file.episodeId) {
      const ep = await this.episodeRepo.findOne({
        where: { id: file.episodeId },
        relations: ['season'],
      });
      if (ep) {
        label = buildSpriteLabel(file.media, {
          seasonNumber: ep.season?.seasonNumber,
          episodeNumber: ep.episodeNumber,
          title: ep.title,
        });
      }
    }
    return this.thumbnails.generateForFile(file, file.media, label, {
      force,
      skipTracking: true,
    });
  }
}
