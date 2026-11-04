import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WantsApiService, type Want, type WantSpec } from '../../../core/services/api/wants-api.service';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { WantsEditorComponent } from '../../../shared/components/wants-editor/wants-editor';
import { ToastService } from '../../../core/services/toast.service';

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

  protected readonly saved = signal<Want[]>([]);
  protected readonly draft = signal<WantSpec[]>([]);
  protected readonly busy = signal(false);

  constructor() {
    effect(() => {
      const id = this.mediaId();
      untracked(() => void this.load(id));
    });
  }

  protected language(code: string | null) {
    return code ? localizeLanguage(code, this.translate) : this.translate.instant('wants.any_language');
  }

  private apply(wants: Want[]) {
    this.saved.set(wants);
    this.draft.set(wants.map(({ family, language, qualityProfileId }) => ({ family, language, qualityProfileId })));
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
