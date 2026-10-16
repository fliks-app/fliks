import { Injectable, Logger } from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getCacheDir } from '../../common/constants/paths';
import { EngineService } from '../engine/engine.service';

/** Sprites the host made before the engine took over: still served through the resolver. */
const legacyDir = () => path.join(getCacheDir(), 'thumbnails');

/** The engine's `Sprite` job generates and serves the sprites (fliks-server runs it); this drops them. */
@Injectable()
export class ThumbnailService {
  private readonly log = new Logger(ThumbnailService.name);

  constructor(private readonly engine: EngineService) {}

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
