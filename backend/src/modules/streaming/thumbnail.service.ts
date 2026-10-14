import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getCacheDir, getDataDir } from '../../common/constants/paths';
import { ActivityRegistryService } from '../scheduler/activity-registry.service';
import {
  EngineService,
  type JobPriority,
  type SpriteMeta,
} from '../engine/engine.service';
import type { MediaFileInfo } from '../media-probe/ffprobe.service';
import type { MediaProgressSubject } from '../../common/utils/media-progress-subject.util';

export type SpriteMetadata = SpriteMeta;

/** Sprites the host made before the engine took over: still served through the resolver. */
const legacyDir = () => path.join(getCacheDir(), 'thumbnails');

/** The engine's `Sprite` job generates and serves the sprites; this tracks them as activity. */
@Injectable()
export class ThumbnailService implements OnModuleInit {
  private readonly log = new Logger(ThumbnailService.name);

  constructor(
    private readonly engine: EngineService,
    private readonly activityRegistry: ActivityRegistryService,
  ) {}

  /** Sprites used to sit directly in the data dir, next to the avatars. */
  async onModuleInit(): Promise<void> {
    if (getCacheDir() === getDataDir()) return;
    for (const name of ['thumbnails', 'thumbnails-tmp']) {
      const dir = path.join(getDataDir(), name);
      await fsp.rm(dir, { recursive: true, force: true }).catch((err) => {
        this.log.warn(`Failed to remove legacy dir "${dir}": ${err}`);
      });
    }
  }

  /** Null when the file has no probed duration or no path yet, or when the job fails. */
  async generateForFile(
    file: {
      id: number;
      relativePath: string;
      streamInfo?: MediaFileInfo | null;
    },
    media: { path: string | null; title: string },
    subject: MediaProgressSubject,
    options: { force?: boolean; priority?: JobPriority } = {},
  ): Promise<SpriteMetadata | null> {
    const info = file.streamInfo;
    const absPath =
      media.path && file.relativePath
        ? path.join(media.path, file.relativePath)
        : null;
    if (!info?.durationSeconds || !absPath) return null;

    const progressKey = `GenerateSprite:${file.id}`;
    this.activityRegistry.upsertPending(progressKey, 'GenerateSprite', subject);
    try {
      const done = await this.engine.runJob(
        {
          kind: { type: 'Sprite', info },
          media: { mediaFileId: file.id, path: absPath },
          priority: options.priority ?? 'low',
          force: options.force,
        },
        (pct) =>
          this.activityRegistry.upsertRunning(
            progressKey,
            'GenerateSprite',
            subject,
            Math.round(pct),
            100,
          ),
      );
      return done.sprite;
    } catch (err) {
      this.log.warn(
        `Sprite failed for file #${file.id} "${media.title}": ${(err as Error).message}`,
      );
      return null;
    } finally {
      this.activityRegistry.remove(progressKey);
    }
  }

  getSpritePath(mediaFileId: number): string {
    return path.join(legacyDir(), String(mediaFileId), 'sprite.jpg');
  }

  getMetadataPath(mediaFileId: number): string {
    return path.join(legacyDir(), String(mediaFileId), 'sprite.json');
  }

  /** Drops a file's sprites, the engine's and any the host made: nothing regenerates them from an
   *  id that no longer exists, so a removed file would leak its sheet forever. */
  async deleteForFile(mediaFileId: number): Promise<void> {
    await this.engine.invalidate(mediaFileId);
    const dir = path.join(legacyDir(), String(mediaFileId));
    await fsp.rm(dir, { recursive: true, force: true }).catch((err) => {
      this.log.warn(
        `Sprite cleanup failed for file #${mediaFileId}: ${(err as Error).message}`,
      );
    });
  }
}
