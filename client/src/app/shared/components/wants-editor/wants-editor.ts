import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, signal } from '@angular/core';
import { LucidePlus, LucideTrash2 } from '@lucide/angular';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { Want, WantFamily, WantSpec } from '../../../core/services/api/wants-api.service';
import { ProfilesService, type QualityProfile } from '../../../core/services/api/profiles.service';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { TvSelectDirective } from '../../directives/tv-select.directive';

const LANGUAGES = ['fr', 'en', 'de', 'es', 'it', 'pt'];
const MAX_WANTS = 8;

export const wantKey = (w: Pick<Want, 'family' | 'language'>) => `${w.family}|${w.language ?? ''}`;

/** The formats and languages a work is wished in, e.g. ebook FR + audio EN. */
@Component({
  selector: 'app-wants-editor',
  imports: [FormsModule, LucidePlus, LucideTrash2, TranslatePipe, TvSelectDirective],
  templateUrl: './wants-editor.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WantsEditorComponent {
  private readonly translate = inject(TranslateService);

  private readonly profilesApi = inject(ProfilesService);

  readonly wants = model.required<WantSpec[]>();
  /** Whether each saved want is owned, keyed by `wantKey`; unsaved rows show no state. */
  readonly state = input<Record<string, boolean> | null>(null);

  /** Create flows: no empty choice, each row starts on its family's first profile. */
  readonly profileRequired = input(false);

  /** The families a row may name, e.g. audio only for an album. */
  readonly families = input<readonly WantFamily[]>(['text', 'audio']);
  protected readonly profiles = signal<Record<WantFamily, QualityProfile[]>>({ text: [], audio: [] });
  protected readonly canAdd = computed(() => this.wants().length < MAX_WANTS && this.free() !== null);
  protected readonly canRemove = computed(() => this.wants().length > 1);

  /** The stored languages stay selectable even outside the offered list. */
  protected languages = computed(() => [
    ...new Set([...LANGUAGES, ...this.wants().flatMap((w) => (w.language ? [w.language] : []))]),
  ]);

  constructor() {
    effect(() => {
      if (!this.profileRequired()) return;
      const all = this.profiles();
      const rows = this.wants();
      if (!rows.some((w) => w.qualityProfileId == null && all[w.family].length)) return;
      this.wants.set(
        rows.map((w) => (w.qualityProfileId == null ? { ...w, qualityProfileId: all[w.family][0]?.id ?? null } : w)),
      );
    });
    for (const family of ['text', 'audio'] as const) {
      this.profilesApi
        .getQualityProfiles(family)
        .then((list) => this.profiles.update((p) => ({ ...p, [family]: list })))
        .catch(() => undefined);
    }
  }

  protected readonly key = wantKey;

  protected label(code: string) {
    return localizeLanguage(code, this.translate);
  }

  protected set(i: number, patch: Partial<WantSpec>) {
    this.wants.update((all) => all.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  }

  protected setFamily(i: number, family: WantFamily) {
    this.set(i, { family, qualityProfileId: null });
  }

  protected remove(i: number) {
    this.wants.update((all) => all.filter((_, j) => j !== i));
  }

  protected add() {
    const next = this.free();
    if (next) this.wants.update((all) => [...all, next]);
  }

  /** The first family and language pair not wished yet. */
  private free(): WantSpec | null {
    const taken = this.wants();
    for (const language of [null, ...LANGUAGES]) {
      for (const family of this.families()) {
        if (!taken.some((w) => w.family === family && w.language === language)) return { family, language };
      }
    }
    return null;
  }
}
