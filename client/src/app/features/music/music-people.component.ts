import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { MusicPersonRow } from '../../core/services/api/music.models';
import { CachedSrcDirective } from '../../shared/directives/cached-src.directive';

const PAGE = 60;

/** The artists or the composers of a library, as a grid of avatars. */
@Component({
  selector: 'app-music-people',
  imports: [FormsModule, RouterLink, TranslatePipe, TranslatePluralPipe, ResolveUrlPipe, CachedSrcDirective],
  templateUrl: './music-people.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicPeopleComponent {
  readonly role = input.required<'artist' | 'composer'>();
  readonly libraryId = input<number | undefined>(undefined);

  private readonly api = inject(MusicApiService);
  protected readonly rows = signal<MusicPersonRow[]>([]);
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  protected readonly more = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor() {
    effect((onCleanup) => {
      this.role();
      this.libraryId();
      const q = this.query();
      const t = setTimeout(() => untracked(() => void this.load(q, false)), q ? 300 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected link(p: MusicPersonRow): string[] {
    return [this.role() === 'artist' ? '/artists' : '/composers', String(p.id)];
  }

  protected loadMore(): void {
    void this.load(this.query(), true);
  }

  private async load(q: string, append: boolean): Promise<void> {
    const gen = ++this.generation;
    this.loading.set(true);
    try {
      const page = append ? Math.floor(this.rows().length / PAGE) + 1 : 1;
      const got = await this.api.people(this.role(), { libraryId: this.libraryId(), q: q || undefined, page, limit: PAGE });
      if (gen !== this.generation) return;
      this.rows.set(append ? [...this.rows(), ...got] : got);
      this.more.set(got.length === PAGE);
    } catch {
      if (gen === this.generation && !append) this.rows.set([]);
    } finally {
      if (gen === this.generation) this.loading.set(false);
    }
  }
}
