import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { MediaServerProvider } from './media-server-provider.interface';

@Injectable()
export class EmbyProvider implements MediaServerProvider {
  private readonly log = new Logger(EmbyProvider.name);

  readonly type = 'emby';
  readonly label = 'Emby';
  readonly supportedEvents = [
    'download.complete',
    'subtitle.downloaded',
    'subtitle.upgraded',
    'subtitle.synced',
    'file.deleted',
    'media.deleted',
    'library.rescan',
  ];

  async refreshLibrary(url: string, apiKey: string): Promise<void> {
    const base = url.replace(/\/$/, '');
    await axios.post(`${base}/Library/Refresh`, null, {
      headers: { 'X-Emby-Token': apiKey },
      timeout: 30_000,
    });
    this.log.log(`Emby library refresh triggered on ${base}`);
  }

  async testConnection(
    url: string,
    apiKey: string,
  ): Promise<{ ok: boolean; message: string }> {
    const base = url.replace(/\/$/, '');
    try {
      const res = await axios.get<{ ServerName?: string }>(
        `${base}/System/Info`,
        {
          headers: { 'X-Emby-Token': apiKey },
          timeout: 15_000,
        },
      );
      const name = res.data?.ServerName ?? 'Emby';
      return { ok: true, message: `Connecte a ${name}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
