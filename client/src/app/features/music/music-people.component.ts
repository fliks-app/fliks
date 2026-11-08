import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { MusicPersonRow } from '../../core/services/api/music.models';
import { PersonAvatarCardComponent } from '../../shared/components/person-avatar-card/person-avatar-card';
import { PagedList } from './paged-list';

const PAGE = 60;

/** The artists or the composers of a library, as a grid of avatars. */
@Component({
  selector: 'app-music-people',
  imports: [FormsModule, TranslatePipe, TranslatePluralPipe, PersonAvatarCardComponent],
  templateUrl: './music-people.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicPeopleComponent {
  readonly role = input.required<'artist' | 'composer'>();
  readonly libraryId = input<number | undefined>(undefined);

  private readonly api = inject(MusicApiService);
  protected readonly query = signal('');
  protected readonly list = new PagedList<MusicPersonRow>(
    (page) => this.api.people(this.role(), { libraryId: this.libraryId(), q: this.query() || undefined, page, limit: PAGE }),
    PAGE,
  );

  constructor() {
    effect((onCleanup) => {
      this.role();
      this.libraryId();
      const q = this.query();
      const t = setTimeout(() => untracked(() => void this.list.load()), q ? 300 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected link(p: MusicPersonRow): string[] {
    return [this.role() === 'artist' ? '/artists' : '/composers', String(p.id)];
  }
}
