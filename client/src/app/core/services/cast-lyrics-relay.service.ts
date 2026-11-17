import { Injectable, effect, inject, untracked } from '@angular/core';
import { LyricsApiService } from './api/lyrics-api.service';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { CastService } from './cast.service';
import { chunkLyrics } from './cast-lyrics';
import { mainLyrics } from '../../shared/audio-player/lyrics/lyrics-logic';

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
      const karaoke = this.audio.stemMode() !== 'original';
      untracked(() => void this.push(itemId, karaoke));
    });
  }

  private async push(itemId: number | undefined, karaoke: boolean): Promise<void> {
    const seq = ++this.seq;
    if (itemId === undefined) return this.cast.sendFliks({ kind: 'lyrics_clear' });
    try {
      const doc = mainLyrics((await this.api.get(itemId)).structuredLyrics, karaoke);
      if (seq !== this.seq) return;
      if (!doc) return this.cast.sendFliks({ kind: 'lyrics_clear' });
      for (const m of chunkLyrics(doc, itemId, seq)) this.cast.sendFliks(m);
    } catch {
      if (seq === this.seq) this.cast.sendFliks({ kind: 'lyrics_clear' });
    }
  }
}
