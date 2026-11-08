import { Injectable, effect, inject, untracked } from '@angular/core';
import { LyricsApiService } from './api/lyrics-api.service';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { CastService } from './cast.service';
import { chunkLyrics } from './cast-lyrics';

/** Sends the playing track's lyrics to the Chromecast receiver, wherever the phone is in the app. */
@Injectable({ providedIn: 'root' })
export class CastLyricsRelayService {
  private readonly api = inject(LyricsApiService);
  private readonly audio = inject(AudioPlayerService);
  private readonly cast = inject(CastService);
  private seq = 0;

  constructor() {
    effect(() => {
      const itemId = this.cast.isConnected() && this.audio.musicMode() ? this.audio.track()?.itemId : undefined;
      untracked(() => void this.push(itemId));
    });
  }

  private async push(itemId: number | undefined): Promise<void> {
    const seq = ++this.seq;
    if (itemId === undefined) return this.cast.sendFliks({ kind: 'lyrics_clear' });
    try {
      const doc = (await this.api.get(itemId)).structuredLyrics.find((d) => d.kind === 'main');
      if (seq !== this.seq) return;
      if (!doc) return this.cast.sendFliks({ kind: 'lyrics_clear' });
      for (const m of chunkLyrics(doc, itemId, seq)) this.cast.sendFliks(m);
    } catch {
      if (seq === this.seq) this.cast.sendFliks({ kind: 'lyrics_clear' });
    }
  }
}
