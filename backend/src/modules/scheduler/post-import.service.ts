import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { existsSync } from 'fs';
import { MediaFile } from '../media/entities/media-file.entity';
import { Episode } from '../media/entities/episode.entity';
import { EventsService } from './events.service';
import {
  ThumbnailService,
  type SpriteMetadata,
} from '../streaming/thumbnail.service';
import { MarkersService } from '../markers/markers.service';
import { SettingsService } from '../settings/settings.service';
import { PostImportQueueService } from '../../common/post-import/post-import-queue.service';
import {
  buildMediaProgressSubject,
  formatMediaProgressSubject,
} from '../../common/utils/media-progress-subject.util';

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
  /** Ceiling on waiting for the (global, shared) enrichment queue to idle: a
   *  steady trickle of downloads could otherwise keep it busy forever and
   *  sprites/markers would never run. */
  static readonly QUEUE_IDLE_CEILING_MS = 5 * 60_000;
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
    @Inject(forwardRef(() => PostImportQueueService))
    private readonly postImportQueue: PostImportQueueService,
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
   *  fingerprint pass, and both compete for the same ffmpeg budget as import. */
  private async run(mediaId: number): Promise<void> {
    let ceilingTimer!: NodeJS.Timeout;
    const ceiling = new Promise<void>((resolve) => {
      ceilingTimer = setTimeout(resolve, PostImportService.QUEUE_IDLE_CEILING_MS);
    });
    await Promise.race([this.postImportQueue.whenIdle(), ceiling]);
    clearTimeout(ceilingTimer);
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

    // Only ids were loaded above to keep a big import off the heap, so resolve titles for
    // the whole missing batch in one extra join (not one query per file) so the progress
    // row can still name a series + episode instead of a bare file id.
    const t0 = Date.now();
    const rows = await this.mediaFileRepo.find({
      where: { id: In(missing.map(({ id }) => id)) },
      relations: ['media', 'episode', 'episode.season'],
      select: {
        id: true,
        media: { title: true },
        episode: {
          id: true,
          episodeNumber: true,
          title: true,
          season: { seasonNumber: true },
        },
      },
    });
    const subjectById = new Map(
      rows
        .filter((f) => f.media)
        .map((f) => [
          f.id,
          buildMediaProgressSubject(
            f.media,
            f.episode
              ? {
                  seasonNumber: f.episode.season?.seasonNumber,
                  episodeNumber: f.episode.episodeNumber,
                  title: f.episode.title,
                }
              : null,
          ),
        ]),
    );
    this.log.debug?.(
      `generateMissingSprites[media #${mediaId}]: resolved ${rows.length} title(s) for progress in ${Date.now() - t0}ms`,
    );

    const command = `GenerateMissingSprites:${mediaId}`;
    let generated = 0;
    for (const [index, { id }] of missing.entries()) {
      const subject = subjectById.get(id);
      this.events.emit({
        type: 'task.progress',
        command,
        current: index,
        total: missing.length,
        message: subject ? formatMediaProgressSubject(subject) : command,
        subject,
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
   * Resolve the file's absolute path + progress subject from its own rows and
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

    let subject = buildMediaProgressSubject(file.media);
    if (file.episodeId) {
      const ep = await this.episodeRepo.findOne({
        where: { id: file.episodeId },
        relations: ['season'],
      });
      if (ep) {
        subject = buildMediaProgressSubject(file.media, {
          seasonNumber: ep.season?.seasonNumber,
          episodeNumber: ep.episodeNumber,
          title: ep.title,
        });
      }
    }
    return this.thumbnails.generateForFile(file, file.media, subject, {
      force,
      skipTracking: true,
    });
  }
}
