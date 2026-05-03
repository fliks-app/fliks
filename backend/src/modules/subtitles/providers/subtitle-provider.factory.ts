import { Injectable } from '@nestjs/common';
import { SubtitleProviderType } from '../../../common/enums';
import { SubtitleProviderInterface } from './subtitle-provider.interface';
import { OpenSubtitlesProvider } from './opensubtitles.provider';
import { SubdlProvider } from './subdl.provider';
import { SubsynchroProvider } from './subsynchro.provider';
import { SupersubtitlesProvider } from './supersubtitles.provider';
import { YifyProvider } from './yify.provider';
import { GestdownProvider } from './gestdown.provider';

@Injectable()
export class SubtitleProviderFactory {
  create(
    type: SubtitleProviderType,
    settings: Record<string, unknown>,
  ): SubtitleProviderInterface {
    switch (type) {
      case SubtitleProviderType.OPENSUBTITLES:
        return new OpenSubtitlesProvider(settings as any);
      case SubtitleProviderType.SUBDL:
        return new SubdlProvider(settings as any);
      case SubtitleProviderType.SUBSYNCHRO:
        return new SubsynchroProvider(settings as any);
      case SubtitleProviderType.SUPERSUBTITLES:
        return new SupersubtitlesProvider(settings as any);
      case SubtitleProviderType.YIFY:
        return new YifyProvider();
      case SubtitleProviderType.GESTDOWN:
        return new GestdownProvider();
      default:
        throw new Error(`Unsupported subtitle provider type: ${type}`);
    }
  }
}
