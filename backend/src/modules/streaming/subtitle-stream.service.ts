import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubtitleFile } from '../subtitles/entities/subtitle-file.entity';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StreamingService } from './streaming.service';

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
    });
    if (!sub?.filePath) {
      throw new NotFoundException(`Subtitle #${subtitleId} not found`);
    }

    const content = await fs.readFile(sub.filePath, 'utf-8');
    const ext = path.extname(sub.filePath).toLowerCase();

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
    const resolved = await this.streamingService.resolveFile(mediaFileId);
    const { spawn } = require('child_process');

    const proc = spawn('ffmpeg', [
      '-i', resolved.absolutePath,
      '-map', `0:${streamIndex}`,
      '-f', 'webvtt',
      '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    return proc.stdout as Readable;
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
