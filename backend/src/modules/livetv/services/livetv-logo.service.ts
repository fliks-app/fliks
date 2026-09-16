import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ImageService, type ImageType } from '../../images/image.service';
import { LiveTvChannel } from '../entities/livetv-channel.entity';

const CONCURRENCY = 4;
const REMOTE_URL = /^https?:\/\//i;

// 'livetv' isn't a registered ImageType yet (needs a case in image.service.ts);
// until then every call below throws, caught per-channel, remote URL kept.
const LIVETV_IMAGE_TYPE = 'livetv' as unknown as ImageType;

/** Caches each channel's provider-hosted logo locally so playback never
 *  hotlinks the source; a failed download leaves the remote URL in place. */
@Injectable()
export class LiveTvLogoService {
  private readonly log = new Logger(LiveTvLogoService.name);

  constructor(
    @InjectRepository(LiveTvChannel)
    private readonly channelRepo: Repository<LiveTvChannel>,
    private readonly images: ImageService,
  ) {}

  async cacheLogos(channels: { id: number; logoPath: string | null }[]): Promise<void> {
    const targets = channels.filter((c) => c.logoPath && REMOTE_URL.test(c.logoPath));
    if (!targets.length) return;
    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const channel = targets[index++];
        await this.cacheOne(channel.id, channel.logoPath as string);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
    );
  }

  private async cacheOne(channelId: number, remoteUrl: string): Promise<void> {
    try {
      const localPath = await this.images.downloadAndStore(
        remoteUrl,
        LIVETV_IMAGE_TYPE,
        channelId,
        'logo',
      );
      if (localPath) await this.channelRepo.update(channelId, { logoPath: localPath });
    } catch (err) {
      this.log.warn(
        `Logo cache failed for channel #${channelId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
