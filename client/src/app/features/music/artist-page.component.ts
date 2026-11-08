import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { Discography } from '../../core/services/api/music.models';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';
import { FollowToggleComponent } from '../../shared/components/follow-toggle/follow-toggle';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { groupDiscography } from './music-utils';

/** An artist: biography, follow, and the discography by release type with the albums not in the library apart. */
@Component({
  selector: 'app-artist-page',
  imports: [TranslatePipe, ResolveUrlPipe, CachedSrcDirective, FollowToggleComponent, MediaCardComponent],
  templateUrl: './artist-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtistPageComponent {
  private readonly api = inject(MusicApiService);
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => Number(p.get('id')))), { initialValue: 0 });
  protected readonly data = signal<Discography | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly groups = computed(() => groupDiscography(this.data()?.albums ?? []));
  protected readonly subtitle = computed(() => {
    const a = this.data()?.artist;
    return [a?.artistType, a?.disambiguation].filter(Boolean).join(' · ');
  });
  protected readonly expanded = signal(false);

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    this.expanded.set(false);
    try {
      const d = await this.api.discography(id);
      if (id === this.id()) this.data.set(d);
    } catch {
      if (id === this.id()) this.failed.set(true);
    } finally {
      if (id === this.id()) this.loading.set(false);
    }
  }
}
