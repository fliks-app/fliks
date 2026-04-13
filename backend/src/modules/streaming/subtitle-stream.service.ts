import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { Readable } from 'stream';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StreamingService } from './streaming.service';
import { resolveSubtitleAbsolutePath } from '../subtitles/subtitle-path.util';
import { TRANSCODE_DIR } from '../../common/constants/paths';

const execFileAsync = promisify(execFile);

@Injectable()
export class SubtitleStreamService {
  private readonly log = new Logger(SubtitleStreamService.name);

  constructor(
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    private readonly streamingService: StreamingService,
  ) {}

  /**
   * Get an external subtitle file converted to WebVTT.
   */
  async getSubtitleAsVtt(subtitleId: number): Promise<string> {
    const sub = await this.subtitleFileRepo.findOne({
      where: { id: subtitleId },
      relations: ['media', 'media.rootFolder'],
    });
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

    // Validate the subtitle path resolves to a real location (no traversal via symlinks)
    let realSubPath: string;
    try {
      realSubPath = await fs.realpath(absolute);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.error(
        `Subtitle #${subtitleId}: file missing or unreadable at resolved path "${absolute}" (stored relativePath="${sub.relativePath}") (${detail})`,
      );
      throw new NotFoundException(`Subtitle file not found on disk`);
    }

    const content = await fs.readFile(realSubPath, 'utf-8');
    const ext = path.extname(realSubPath).toLowerCase();

    if (ext === '.vtt') return content;
    if (ext === '.srt') return this.srtToVtt(content);
    if (ext === '.ass' || ext === '.ssa') return this.assToVtt(content);

    // Fallback: try SRT conversion
    return this.srtToVtt(content);
  }

  /**
   * Extract an embedded subtitle stream as WebVTT using FFmpeg.
   */
  async extractEmbeddedSubtitle(
    mediaFileId: number,
    streamIndex: number,
  ): Promise<Readable> {
    if (
      !Number.isInteger(streamIndex) ||
      streamIndex < 0 ||
      streamIndex > 999
    ) {
      throw new BadRequestException(`Invalid stream index: ${streamIndex}`);
    }

    // Cache extracted VTTs on disk. First extraction spawns FFmpeg (slow on
    // 4K MKV — decodes the file header-to-end to read the subtitle stream),
    // subsequent requests stream the cached file instantly. Especially
    // important on Android where ExoPlayer pre-fetches every sub URL
    // declared in the MediaItem during load — without caching, a file with
    // 3-5 embedded subs adds 15-20s to player startup, serialising 5 full
    // FFmpeg invocations.
    const cacheDir = path.join(TRANSCODE_DIR, 'subs', String(mediaFileId));
    const cachePath = path.join(cacheDir, `emb-${streamIndex}.vtt`);
    if (fsSync.existsSync(cachePath)) {
      return fsSync.createReadStream(cachePath);
    }

    const resolved = await this.streamingService.resolveFile(mediaFileId);
    await fs.mkdir(cacheDir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'ffmpeg',
        [
          // Trusted streamInfo populated at import — skip the probe scan.
          '-analyzeduration', '0', '-probesize', '200000',
          // Skip video + audio streams: we only need the subtitle track.
          '-vn', '-an',
          '-i', resolved.absolutePath,
          '-map', `0:${streamIndex}`,
          '-f', 'webvtt',
          '-y', cachePath,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderrTail = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-1000);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg subtitle extract failed (${code}): ${stderrTail}`));
      });
      proc.on('error', reject);
    });

    return fsSync.createReadStream(cachePath);
  }

  private srtToVtt(srt: string): string {
    // Replace SRT timestamp format (00:00:00,000) with VTT format (00:00:00.000)
    const body = srt
      .replace(/\r\n/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return `WEBVTT\n\n${body}`;
  }

  private assToVtt(ass: string): string {
    const lines: string[] = ['WEBVTT', ''];
    const dialogueRegex =
      /^Dialogue:\s*\d+,(\d+:\d{2}:\d{2}\.\d{2}),(\d+:\d{2}:\d{2}\.\d{2}),([^,]*),([^,]*),\d+,\d+,\d+,([^,]*),(.*)/;

    let cueIndex = 1;
    for (const line of ass.split(/\r?\n/)) {
      const match = dialogueRegex.exec(line);
      if (!match) continue;

      const start = this.assTimeToVtt(match[1]);
      const end = this.assTimeToVtt(match[2]);
      // Strip ASS tags like {\b1}, {\i0}, {\an8}, etc.
      const text = match[6]
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/g, '\n')
        .replace(/\\n/g, '\n')
        .trim();

      if (!text) continue;

      lines.push(String(cueIndex++));
      lines.push(`${start} --> ${end}`);
      lines.push(text);
      lines.push('');
    }

    return lines.join('\n');
  }

  private assTimeToVtt(assTime: string): string {
    // ASS: H:MM:SS.CS → VTT: HH:MM:SS.MMS
    const parts = assTime.split(/[:.]/);
    const h = parts[0].padStart(2, '0');
    const m = parts[1];
    const s = parts[2];
    const cs = parts[3];
    return `${h}:${m}:${s}.${cs}0`;
  }
}
