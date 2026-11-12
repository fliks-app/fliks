import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideChevronLeft, LucidePlay } from '@lucide/angular';
import { NavbarService } from '../../core/services/navbar.service';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import { PersonsApiService, type Person } from '../../core/services/api/persons-api.service';
import type { ComposerWork, WorkRecording } from '../../core/services/api/music.models';
import { PersonHeaderComponent } from '../../shared/components/person-header/person-header';
import { TrackLineComponent } from './track-line.component';
import type { HandedPerson } from './artist-page.component';

/** A composer: the works, and per work the recordings in the library (fetched when the work opens). */
@Component({
  selector: 'app-composer-page',
  imports: [RouterLink, TranslatePipe, TranslatePluralPipe, PersonHeaderComponent, TrackLineComponent, LucidePlay, LucideChevronLeft],
  templateUrl: './composer-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerPageComponent {
  private readonly api = inject(MusicApiService);
  private readonly persons = inject(PersonsApiService);
  private readonly player = inject(AudioPlayerService);
  private readonly navbar = inject(NavbarService);
  protected readonly skeletonRows = Array.from({ length: 6 }, (_, i) => i);
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => Number(p.get('id')))), { initialValue: 0 });
  protected readonly works = signal<ComposerWork[]>([]);
  protected readonly loading = signal(true);
  protected readonly recordings = signal<Record<number, WorkRecording[]>>({});
  protected readonly person = signal<Person | null>(null);
  private readonly handed: HandedPerson | null =
    (inject(Router).getCurrentNavigation()?.extras.state ?? history.state)?.person ?? null;
  /** The loaded person, else what the card handed over so the header is there when the transition captures. */
  protected readonly head = computed(() => {
    const h = this.handed;
    return this.person() ?? (h?.id === this.id() ? { name: h.name, avatarUrl: h.avatarUrl, biography: null } : null);
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.recordings.set({});
    this.person.set(null);
    void this.persons.getOne(id).then((d) => id === this.id() && this.person.set(d.person), () => undefined);
    try {
      const w = await this.api.composerWorks(id);
      if (id === this.id()) this.works.set(w);
    } catch {
      if (id === this.id()) this.works.set([]);
    } finally {
      if (id === this.id()) this.loading.set(false);
    }
  }

  protected goBack(): void {
    this.navbar.goBack(['/']);
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
