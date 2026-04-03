import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { SubtitleFilenamePipe } from '../../../../shared/pipes/subtitle-filename.pipe';
import { SubtitleFileRow, SyncOptions, MediaStream } from '../../../../core/services/api/subtitles-api.service';
import { SubtitleLanguageItem } from '../../../../core/services/api/profiles.service';

interface SubtitleRow {
  sub?: SubtitleFileRow;
  language: string;
  missing: boolean;
}

@Component({
  selector: 'app-media-detail-subtitles',
  imports: [FormsModule, TranslateModule, SubtitleFilenamePipe],
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
  /** External subtitle files that can be used as sync reference (excluding the one being synced) */
  readonly externalSubtitleRefs = computed(() =>
    this.subtitles().filter((s) => s.filePath && s.id !== this.syncSubtitleId()),
  );

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

  // Adjust Times modal
  private readonly adjustDialog = viewChild<ElementRef<HTMLDialogElement>>('adjustDialog');
  readonly adjustSubtitleId = signal<number | null>(null);
  readonly adjustMinutes = signal('0');
  readonly adjustSeconds = signal('0');
  readonly adjustMillis = signal('0');

  openAdjustModal(subtitleId: number) {
    this.adjustSubtitleId.set(subtitleId);
    this.adjustMinutes.set('0');
    this.adjustSeconds.set('0');
    this.adjustMillis.set('0');
    this.adjustDialog()?.nativeElement.showModal();
  }

  closeAdjustModal() {
    this.adjustDialog()?.nativeElement.close();
  }

  confirmAdjust() {
    const id = this.adjustSubtitleId();
    if (id == null) return;
    const offsetMs =
      Number(this.adjustMinutes()) * 60000 +
      Number(this.adjustSeconds()) * 1000 +
      Number(this.adjustMillis());
    this.postProcess.emit({ subtitleId: id, action: 'adjustTimes', params: { offsetMs } });
    this.closeAdjustModal();
  }

  // Change Frame Rate modal
  private readonly fpsDialog = viewChild<ElementRef<HTMLDialogElement>>('fpsDialog');
  readonly fpsSubtitleId = signal<number | null>(null);
  readonly fpsFrom = signal('23.976');
  readonly fpsTo = signal('25');

  openFpsModal(subtitleId: number) {
    this.fpsSubtitleId.set(subtitleId);
    this.fpsFrom.set('23.976');
    this.fpsTo.set('25');
    this.fpsDialog()?.nativeElement.showModal();
  }

  closeFpsModal() {
    this.fpsDialog()?.nativeElement.close();
  }

  confirmFps() {
    const id = this.fpsSubtitleId();
    if (id == null) return;
    this.postProcess.emit({ subtitleId: id, action: 'changeFrameRate', params: { fromFps: Number(this.fpsFrom()), toFps: Number(this.fpsTo()) } });
    this.closeFpsModal();
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
