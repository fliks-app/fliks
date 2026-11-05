import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { WantsApiService, type WantSpec } from '../../../core/services/api/wants-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { WantsEditorComponent } from '../wants-editor/wants-editor';

interface Current {
  libraryId: number;
  wants: WantSpec[];
  newReleases?: boolean;
}

const DEFAULT_WANTS = (): WantSpec[] => [
  { family: 'text', language: null },
  { family: 'audio', language: null },
];

/** Follow the new releases of an author, or watch a series: where new titles land and what they are wished in. */
@Component({
  selector: 'app-follow-toggle',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, WantsEditorComponent],
  templateUrl: './follow-toggle.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', '[class.hidden]': '!available()' },
})
export class FollowToggleComponent {
  private readonly api = inject(WantsApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly kind = input.required<'person' | 'series'>();
  readonly targetId = input.required<number>();

  protected readonly available = signal(false);
  protected readonly current = signal<Current | null>(null);
  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly libraries = signal<LibrarySummary[]>([]);
  protected readonly libraryId = signal<number | null>(null);
  protected readonly wants = signal<WantSpec[]>(DEFAULT_WANTS());
  protected readonly prefix = computed(() => (this.kind() === 'person' ? 'follows.person' : 'follows.series'));

  constructor() {
    effect(() => {
      const id = this.targetId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: number) {
    this.available.set(false);
    this.editing.set(false);
    if (!this.auth.hasPermission('media.create')) return;
    try {
      const libs = (await this.librariesApi.listMine()).filter((l) => l.mediaTypes.includes('book'));
      let canFollow = true;
      if (this.kind() === 'person') {
        const state = await this.api.personFollow(id);
        this.current.set(state.follow);
        canFollow = state.canFollow;
      } else {
        this.current.set(await this.api.seriesWatch(id));
      }
      this.libraries.set(libs);
      this.available.set(canFollow && libs.length > 0);
    } catch {
      /* the toggle stays hidden */
    }
  }

  protected open() {
    const c = this.current();
    this.libraryId.set(c?.libraryId ?? this.libraries()[0]?.id ?? null);
    this.wants.set(c ? c.wants.map((w) => ({ ...w })) : DEFAULT_WANTS());
    this.editing.set(true);
  }

  protected async save() {
    const libraryId = this.libraryId();
    if (libraryId == null || this.busy()) return;
    this.busy.set(true);
    try {
      const body = { libraryId, wants: this.wants() };
      const id = this.targetId();
      if (this.kind() === 'person') {
        this.current.set((await this.api.followPerson(id, body)).follow);
      } else {
        this.current.set(await this.api.watchSeries(id, body));
      }
      this.editing.set(false);
      this.toast.success(this.translate.instant('follows.saved'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async stop() {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const id = this.targetId();
      await (this.kind() === 'person' ? this.api.unfollowPerson(id) : this.api.unwatchSeries(id));
      this.current.set(null);
      this.editing.set(false);
      this.toast.success(this.translate.instant('follows.stopped'));
    } finally {
      this.busy.set(false);
    }
  }
}
