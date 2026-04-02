import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { SubtitleFileRow } from '../../../../core/services/api/subtitles-api.service';
import { SubtitleLanguageItem } from '../../../../core/services/api/profiles.service';

interface SubtitleRow {
  sub?: SubtitleFileRow;
  language: string;
  missing: boolean;
}

@Component({
  selector: 'app-media-detail-subtitles',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-subtitles.component.html',
})
export class MediaDetailSubtitlesComponent {
  /** Affichage compact dans le drawer épisode (pas de divider large). */
  readonly embedded = input(false);
  /** Désactive la recherche (ex. pas de fichier vidéo pour cet épisode). */
  readonly searchDisabled = input(false);
  readonly subtitles = input.required<SubtitleFileRow[]>();
  readonly requiredLanguages = input<SubtitleLanguageItem[]>([]);
  readonly subtitlesLoading = input(false);
  readonly canGrab = input(false);
  readonly subtitleActionBusy = input(false);

  /** Merged list: existing subtitles + missing placeholders for required languages. */
  readonly rows = computed<SubtitleRow[]>(() => {
    const subs = this.subtitles();
    const required = this.requiredLanguages();
    const existingLangs = new Set(subs.map((s) => s.language));

    const rows: SubtitleRow[] = subs.map((s) => ({ sub: s, language: s.language, missing: false }));

    for (const lang of required) {
      if (!existingLangs.has(lang.isoCode)) {
        rows.push({ language: lang.isoCode, missing: true });
      }
    }

    return rows;
  });

  readonly hasMissing = computed(() => this.rows().some((r) => r.missing));

  readonly pageSize = 10;
  readonly page = signal(0);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.rows().length / this.pageSize)));
  readonly pagedRows = computed(() => {
    const start = this.page() * this.pageSize;
    return this.rows().slice(start, start + this.pageSize);
  });

  goToPage(p: number) {
    this.page.set(Math.max(0, Math.min(p, this.totalPages() - 1)));
  }

  readonly openSubtitleSearch = output<void>();
  readonly autoSubtitle = output<void>();
  readonly syncSubtitle = output<number>();
  readonly deleteSubtitle = output<number>();
}
