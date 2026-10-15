import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StreamingService } from './streaming.service';
import { User } from '../users/entities/user.entity';
import { resolveSubtitleAbsolutePath } from '../subtitles/subtitle-path.util';
import { normalizeLanguageCode } from '../../common/constants/app-languages';
import { isRenderableTextSidecar } from '../../common/constants/subtitle-codecs';
import { getCacheDir, getDataDir } from '../../common/constants/paths';

/** A text subtitle track the engine publishes as an HLS `SUBTITLES` rendition. */
export interface SubtitleRenditionMeta {
  kind: 'embedded' | 'external';
  key: number;
  language?: string;
  /** Embedded tracks only: the container's BCP-47 tag (`es-419`). */
  languageTag?: string;
  name: string;
  forced?: boolean;
}

@Injectable()
export class SubtitleStreamService implements OnModuleInit {
  private readonly log = new Logger(SubtitleStreamService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    private readonly streamingService: StreamingService,
  ) {}

  /** The host's own VTT cache is gone (the engine extracts and serves embedded tracks). */
  async onModuleInit(): Promise<void> {
    for (const dir of new Set([getCacheDir(), getDataDir()])) {
      const legacy = path.join(dir, 'subs');
      await fs.rm(legacy, { recursive: true, force: true }).catch((err) => {
        this.log.warn(`Failed to remove legacy subs dir "${legacy}": ${err}`);
      });
    }
  }

  /** ACL is checked on the subtitle's OWN media, so a foreign id can't be read
   *  via another mediaFileId (IDOR); realpath blocks symlink escapes. */
  private async resolveSubtitleOnDisk(
    subtitleId: number,
    user?: User,
  ): Promise<string> {
    const sub = await this.subtitleFileRepo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'media.library'],
    });
    await this.streamingService.assertLibraryAccess(
      sub?.media?.libraryId ?? null,
      user,
      `Subtitle #${subtitleId} not found`,
    );
    if (!sub?.relativePath) {
      throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    }

    const mediaPath = sub.media?.path ?? null;
    const absolute = resolveSubtitleAbsolutePath(mediaPath, sub.relativePath);
    if (!absolute) {
      this.log.error(
        `Subtitle #${subtitleId}: cannot resolve path under media (mediaPath=${mediaPath ?? 'null'}, relativePath="${sub.relativePath}")`,
      );
      throw new NotFoundException(`Subtitle file not found on disk`);
    }

    try {
      return await fs.realpath(absolute);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.error(
        `Subtitle #${subtitleId}: file missing or unreadable at resolved path "${absolute}" (stored relativePath="${sub.relativePath}") (${detail})`,
      );
      throw new NotFoundException(`Subtitle file not found on disk`);
    }
  }

  /** The stored file, named after the copy on disk so its original extension
   *  survives — the player's VTT is a conversion. */
  async getSubtitleFileForDownload(
    subtitleId: number,
    user?: User,
  ): Promise<{ path: string; filename: string }> {
    const realSubPath = await this.resolveSubtitleOnDisk(subtitleId, user);
    return { path: realSubPath, filename: path.basename(realSubPath) };
  }

  /**
   * Text subtitle tracks for the HLS master's `SUBTITLES` group: embedded
   * non-bitmap streams (from cached `streamInfo`) then external files. Bitmap
   * subtitles (PGS/DVD/DVB) and sidecars that can't become WebVTT are
   * excluded — they have no WebVTT form and stay on the burn-in path. `key` feeds the VTT endpoints (`subtitles/embedded/:idx`,
   * `subtitles/:id`); `name` is a human label (track title / language /
   * "Subtitle") shown by native players (AirPlay, lock-screen). It is NOT a
   * stable id — the master playlist uniquifies colliding names with an
   * increment, and the client no longer matches a track on it.
   */
  async listTextSubtitleRenditions(
    mediaFileId: number,
    user?: User,
  ): Promise<SubtitleRenditionMeta[]> {
    const out: SubtitleRenditionMeta[] = [];
    const resolved = await this.streamingService.resolveFile(mediaFileId, user);
    for (const s of resolved.mediaFile.streamInfo?.subtitles ?? []) {
      if (s.isImageBased) continue;
      out.push({
        kind: 'embedded',
        key: s.streamIndex,
        language: normalizeLanguageCode(s.language),
        languageTag: s.languageTag,
        name: s.title || normalizeLanguageCode(s.language) || 'Subtitle',
        forced: s.forced,
      });
    }
    // External subtitle files. Query through the relation — `mediaFileId` on
    // SubtitleFile is a @RelationId (virtual), which TypeORM rejects in a
    // `where`. Isolated so a query failure can never drop the embedded subs.
    try {
      const external = await this.subtitleFileRepo.find({
        where: { mediaFile: { id: mediaFileId } },
        // Stable id order so the manifest rendition order (and thus the
        // client's same-language ordinal) is deterministic across requests.
        order: { id: 'ASC' },
      });
      for (const sf of external) {
        if (!isRenderableTextSidecar(sf)) continue;
        out.push({
          kind: 'external',
          key: sf.id,
          language: normalizeLanguageCode(sf.language),
          name: sf.language || 'Subtitle',
          forced: sf.forced,
        });
      }
    } catch (e) {
      this.log.warn(
        `listTextSubtitleRenditions: external query failed for #${mediaFileId}: ${e instanceof Error ? e.message : e}`,
      );
    }
    return out;
  }
}
