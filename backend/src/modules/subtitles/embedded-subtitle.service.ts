import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as path from 'path';
import { SubtitleFile } from './entities/subtitle-file.entity';
import { Media } from '../media/entities/media.entity';
import { MediaFile } from '../media/entities/media-file.entity';
import { FfprobeService } from './ffprobe.service';
import { SubtitleProviderType, SubtitleStatus } from '../../common/enums';

/**
 * Map ISO 639-2/B (ffprobe output) → ISO 639-1 (used in language profiles).
 * Only includes codes where the two differ.
 */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  jpn: 'ja',
  kor: 'ko',
  zho: 'zh',
  chi: 'zh',
  ara: 'ar',
  hin: 'hi',
  tha: 'th',
  vie: 'vi',
  tur: 'tr',
  pol: 'pl',
  nld: 'nl',
  dut: 'nl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  ces: 'cs',
  cze: 'cs',
  slk: 'sk',
  slo: 'sk',
  ron: 'ro',
  rum: 'ro',
  hun: 'hu',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  slv: 'sl',
  ukr: 'uk',
  ell: 'el',
  gre: 'el',
  heb: 'he',
  ind: 'id',
  msa: 'ms',
  may: 'ms',
  cat: 'ca',
  eus: 'eu',
  baq: 'eu',
  glg: 'gl',
};

function normalizeLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  // Already ISO 639-1 (2 chars)?
  if (lower.length === 2) return lower;
  // Map from ISO 639-2
  return ISO_639_2_TO_1[lower] ?? lower;
}

@Injectable()
export class EmbeddedSubtitleService {
  private readonly logger = new Logger(EmbeddedSubtitleService.name);

  constructor(
    private readonly ffprobe: FfprobeService,
    @InjectRepository(SubtitleFile)
    private readonly subtitleFileRepo: Repository<SubtitleFile>,
    @InjectRepository(Media)
    private readonly mediaRepo: Repository<Media>,
    @InjectRepository(MediaFile)
    private readonly mediaFileRepo: Repository<MediaFile>,
  ) {}

  async detectAndStore(
    mediaId: number,
    mediaFileId: number,
    episodeId?: number,
  ): Promise<SubtitleFile[]> {
    const videoPath = await this.resolveVideoPath(mediaId, mediaFileId);
    if (!videoPath) return [];

    const streams = await this.ffprobe.detectEmbeddedSubtitles(videoPath);
    if (!streams.length) {
      this.logger.log(`No embedded subtitles in "${path.basename(videoPath)}"`);
      return [];
    }

    this.logger.log(
      `Found ${streams.length} embedded subtitle(s) in "${path.basename(videoPath)}"`,
    );

    // Remove all existing embedded subs for this file, then recreate
    await this.subtitleFileRepo.delete({
      mediaFile: { id: mediaFileId },
      providerType: SubtitleProviderType.EMBEDDED,
    });

    const created: SubtitleFile[] = [];
    for (const stream of streams) {
      const sub = this.subtitleFileRepo.create({
        media: { id: mediaId } as any,
        mediaFile: { id: mediaFileId } as any,
        episode: episodeId ? ({ id: episodeId } as any) : undefined,
        language: normalizeLanguage(stream.language),
        forced: stream.forced,
        hearingImpaired: stream.hearingImpaired,
        providerType: SubtitleProviderType.EMBEDDED,
        providerFileId: undefined,
        relativePath: undefined,
        status: SubtitleStatus.EMBEDDED,
        score: 100,
        synced: false,
        streamIndex: stream.streamIndex,
        codec: stream.codec,
      });
      created.push(sub);
    }

    if (created.length) {
      await this.subtitleFileRepo.save(created);
    }
    this.logger.log(
      `Refreshed embedded subtitles for mediaFile #${mediaFileId}: ${created.length} stored`,
    );

    return created;
  }

  private async resolveVideoPath(
    mediaId: number,
    mediaFileId: number,
  ): Promise<string | null> {
    const media = await this.mediaRepo.findOne({ where: { id: mediaId } });
    if (!media?.path) return null;
    const mediaFile = await this.mediaFileRepo.findOne({
      where: { id: mediaFileId },
    });
    if (!mediaFile) return null;
    return path.join(media.path, mediaFile.relativePath);
  }
}
