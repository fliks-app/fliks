import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SubtitleFileRow, SyncOptions, MediaStream } from '../../../../core/services/api/subtitles-api.service';
import { SubtitleLanguageItem } from '../../../../core/services/api/profiles.service';

interface SubtitleRow {
  sub?: SubtitleFileRow;
  language: string;
  missing: boolean;
}

@Component({
  selector: 'app-media-detail-subtitles',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-subtitles.component.html',
})
export class MediaDetailSubtitlesComponent {
  readonly embedded = input(false);
  readonly searchDisabled = input(false);
  readonly subtitles = input.required<SubtitleFileRow[]>();
  readonly requiredLanguages = input<SubtitleLanguageItem[]>([]);
  readonly subtitlesLoading = input(false);
  readonly canGrab = input(false);
  readonly subtitleActionBusy = input(false);
  readonly streams = input<MediaStream[]>([]);

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
  readonly syncSubtitle = output<{ subtitleId: number; options: SyncOptions }>();
  readonly deleteSubtitle = output<number>();
  readonly blacklistSubtitle = output<SubtitleFileRow>();
  readonly postProcess = output<{ subtitleId: number; action: string; params?: Record<string, unknown> }>();

  readonly audioStreams = computed(() => this.streams().filter((s) => s.type === 'audio'));
  readonly subtitleStreams = computed(() => this.streams().filter((s) => s.type === 'subtitle'));

  // Sync modal
  private readonly syncDialog = viewChild<ElementRef<HTMLDialogElement>>('syncDialog');
  readonly syncSubtitleId = signal<number | null>(null);
  readonly syncReference = signal('auto');
  readonly syncMaxOffset = signal('');
  readonly syncNoFixFramerate = signal(false);
  readonly syncGoldenSection = signal(false);

  openSyncModal(subtitleId: number) {
    this.syncSubtitleId.set(subtitleId);
    this.syncReference.set('auto');
    this.syncMaxOffset.set('');
    this.syncNoFixFramerate.set(false);
    this.syncGoldenSection.set(false);
    this.syncDialog()?.nativeElement.showModal();
  }

  closeSyncModal() {
    this.syncDialog()?.nativeElement.close();
  }

  confirmSync() {
    const id = this.syncSubtitleId();
    if (id == null) return;
    const options: SyncOptions = {};
    const ref = this.syncReference().trim();
    if (ref && ref !== 'auto') options.reference = ref;
    const maxOffset = Number(this.syncMaxOffset());
    if (maxOffset > 0) options.maxOffsetSeconds = maxOffset;
    if (this.syncNoFixFramerate()) options.noFixFramerate = true;
    if (this.syncGoldenSection()) options.goldenSectionSearch = true;
    this.syncSubtitle.emit({ subtitleId: id, options });
    this.closeSyncModal();
  }
}
