import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WantsApiService, type Want, type WantFamily, type WantSpec } from '../../../core/services/api/wants-api.service';
import { WantsEditorComponent, wantKey } from '../../../shared/components/wants-editor/wants-editor';
import { ToastService } from '../../../core/services/toast.service';
import { WantsStore } from '../../../core/acquisition/acquisition';

/** The formats and languages a work is wished in, and which of them are already owned. */
@Component({
  selector: 'app-book-wants',
  imports: [TranslatePipe, WantsEditorComponent],
  templateUrl: './book-wants.component.html',
  host: { class: 'block' },
})
export class BookWantsComponent {
  readonly mediaId = input.required<number>();

  private readonly api = inject(WantsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly store = inject(WantsStore);

  protected readonly saved = signal<Want[]>([]);
  protected readonly draft = signal<WantSpec[]>([]);
  protected readonly busy = signal(false);
  protected readonly state = computed(() => Object.fromEntries(this.saved().map((w) => [wantKey(w), w.satisfied])));

  constructor() {
    effect(() => {
      const id = this.mediaId();
      untracked(() => void this.load(id));
    });
  }

  private apply(wants: Want[]) {
    this.saved.set(wants);
    this.store.set(this.mediaId(), wants);
    this.draft.set(
      wants.map(({ family, language, qualityProfileId }) => ({ family: family as WantFamily, language, qualityProfileId })),
    );
  }

  private async load(id: number) {
    try {
      this.apply(await this.api.wants(id));
    } catch {
      /* the section stays empty */
    }
  }

  protected async save() {
    if (this.busy() || !this.draft().length) return;
    this.busy.set(true);
    try {
      this.apply(await this.api.setWants(this.mediaId(), this.draft()));
      this.toast.success(this.translate.instant('wants.saved'));
    } finally {
      this.busy.set(false);
    }
  }
}
