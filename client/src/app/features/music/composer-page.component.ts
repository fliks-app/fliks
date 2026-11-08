import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePlay } from '@lucide/angular';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { ComposerWork, WorkRecording } from '../../core/services/api/music.models';
import { formatDuration } from './music-utils';

/** A composer: the works, and per work the recordings in the library (fetched when the work opens). */
@Component({
  selector: 'app-composer-page',
  imports: [RouterLink, TranslatePipe, TranslatePluralPipe, LucidePlay],
  templateUrl: './composer-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerPageComponent {
  private readonly api = inject(MusicApiService);
  private readonly player = inject(AudioPlayerService);
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => Number(p.get('id')))), { initialValue: 0 });
  protected readonly works = signal<ComposerWork[]>([]);
  protected readonly loading = signal(true);
  protected readonly recordings = signal<Record<number, WorkRecording[]>>({});
  protected readonly fmt = formatDuration;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.recordings.set({});
    try {
      const w = await this.api.composerWorks(id);
      if (id === this.id()) this.works.set(w);
    } catch {
      if (id === this.id()) this.works.set([]);
    } finally {
      if (id === this.id()) this.loading.set(false);
    }
  }

  protected async open(workId: number, opened: boolean): Promise<void> {
    if (!opened || this.recordings()[workId]) return;
    try {
      const r = await this.api.workRecordings(workId);
      this.recordings.update((m) => ({ ...m, [workId]: r }));
    } catch {
      this.recordings.update((m) => ({ ...m, [workId]: [] }));
    }
  }

  protected performers(r: WorkRecording): string {
    return r.performers.map((p) => p.name).join(', ');
  }

  /** The recording's own track only: the file is on the track item. */
  protected play(r: WorkRecording): Promise<void> {
    return this.player.playTracks([
      {
        itemId: r.itemId, mediaId: r.mediaId, title: r.title, artists: this.performers(r), albumTitle: r.albumTitle,
        coverUrl: r.posterUrl, durationSeconds: r.durationSeconds, gain: null, peak: null, albumGain: null, albumPeak: null,
      },
    ]);
  }
}
