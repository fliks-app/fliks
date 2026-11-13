import { Component, ElementRef, OnInit, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import type { KaraokeLanguage, KaraokeModel, KaraokeModelKind, KaraokeModels, KaraokeOrphan } from '../../../core/services/api/karaoke.models';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import { formatBytes } from '../../../core/utils/format-bytes';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';
import { formatEta, formatSpeed } from '../../../shared/utils/download-format';

type Group = 'separation' | 'alignment' | 'melody' | 'recognition';

const GROUPS: { key: Group; kind: KaraokeModelKind; whisper: boolean }[] = [
  { key: 'separation', kind: 'separation', whisper: false },
  { key: 'alignment', kind: 'alignment', whisper: false },
  { key: 'melody', kind: 'melody', whisper: false },
  { key: 'recognition', kind: 'alignment', whisper: true },
];

/** The model manager: disk usage, the models by group, the library's languages, orphans and the re-sync. */
@Component({
  selector: 'app-karaoke-models',
  imports: [TranslatePipe, TranslatePluralPipe, SelectFieldComponent, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './karaoke-models.html',
})
export class KaraokeModelsComponent implements OnInit {
  private readonly api = inject(KaraokeApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly confirm = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('licence');

  readonly catalogue = input.required<KaraokeModels>();
  /** A model or the folder changed: the parent loads the catalogue again. */
  readonly reload = output<void>();

  protected readonly busy = signal<string | null>(null);
  protected readonly reviewing = signal<KaraokeModel | null>(null);
  protected readonly accepted = signal(false);
  protected readonly languages = signal<KaraokeLanguage[]>([]);
  protected readonly aligners = signal<Record<string, string>>({});
  protected readonly stale = signal(0);
  protected readonly resyncing = signal(false);

  protected readonly groups = computed(() =>
    GROUPS.map((g) => ({
      key: g.key,
      models: this.catalogue().models.filter((m) => m.kind === g.kind && (m.engine === 'whisper') === g.whisper),
    })).filter((g) => g.models.length),
  );
  /** Changes when a model settles, so a download's progress does not reload the languages. */
  private readonly settled = computed(() => this.catalogue().models.map((m) => `${m.id}:${m.state}`).join());
  protected readonly diskMax = computed(() => this.catalogue().usedBytes + (this.catalogue().freeBytes ?? 0));
  /** The recommended aligners the library's languages miss and whose licence needs no acceptance. */
  protected readonly selection = computed(() => {
    const wanted = new Set(this.languages().map((l) => l.recommended));
    return this.catalogue().models.filter((m) => wanted.has(m.id) && this.canDownload(m) && m.licence.clear);
  });
  protected readonly selectionSize = computed(() => formatBytes(this.selection().reduce((n, m) => n + m.sizeBytes, 0)));

  constructor() {
    inject(SseService)
      .karaokeEvents.pipe(takeUntilDestroyed())
      .subscribe((e) => {
        if (e.type === 'karaoke.job_changed' && (e['state'] === 'ready' || e['state'] === 'failed')) void this.refreshStale();
      });
    effect(() => {
      this.settled();
      void this.refreshLanguages();
    });
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (!el) return;
      if (this.reviewing()) {
        if (!el.open) el.showModal();
      } else if (el.open) el.close();
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      this.aligners.set(parseAligners((await this.settingsApi.getAll())['karaoke.aligners']));
    } catch {
      // The interceptor toasts the reason; no choice is shown.
    }
  }

  private async refreshLanguages(): Promise<void> {
    try {
      this.languages.set(await this.api.languages());
    } catch {
      this.languages.set([]);
    }
    await this.refreshStale();
  }

  private async refreshStale(): Promise<void> {
    try {
      this.stale.set(await this.api.staleTracks());
    } catch {
      this.stale.set(0);
    }
    if (!this.stale()) this.resyncing.set(false);
  }

  protected percent(m: KaraokeModel): number {
    return m.sizeBytes > 0 ? Math.min(100, (m.downloadedBytes / m.sizeBytes) * 100) : 0;
  }

  /** "12.3 MB/s, 2m 10s left" while the engine reports a speed. */
  protected speed(m: KaraokeModel): string | null {
    const rate = m.bytesPerSecond;
    if (!rate) return null;
    return `${formatSpeed(rate)}, ${this.translate.instant('karaoke.admin.remaining', { time: formatEta(Math.ceil((m.sizeBytes - m.downloadedBytes) / rate)) })}`;
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }

  protected languagesOf(m: KaraokeModel): string {
    return m.languages.length ? m.languages.map((l) => this.name(l)).join(', ') : this.translate.instant('karaoke.admin.all_languages');
  }

  protected name(language: string): string {
    return localizeLanguage(language, this.translate);
  }

  protected canDownload(m: KaraokeModel): boolean {
    return m.state === 'absent' || m.state === 'failed' || m.state === 'outdated';
  }

  /** A downloading model with no installed version has nothing to lose; an update or a check keeps its files. */
  protected canCancel(m: KaraokeModel): boolean {
    return m.state === 'downloading' && !m.installedVersion;
  }

  protected canDelete(m: KaraokeModel): boolean {
    return m.state !== 'downloading' && m.diskBytes > 0;
  }

  protected modelOf(id: string | null): KaraokeModel | undefined {
    return this.catalogue().models.find((m) => m.id === id);
  }

  /** The installed alignment models a language can pick from. */
  protected options(l: KaraokeLanguage): KaraokeModel[] {
    return this.catalogue().models.filter(
      (m) =>
        m.kind === 'alignment' &&
        (m.state === 'installed' || m.state === 'outdated') &&
        (!m.languages.length || m.languages.includes(l.language)),
    );
  }

  /** The recommended aligner of a language, when it is not installed. */
  protected missing(l: KaraokeLanguage): KaraokeModel | undefined {
    const m = this.modelOf(l.recommended);
    return m && this.canDownload(m) ? m : undefined;
  }

  protected review(m: KaraokeModel): void {
    this.accepted.set(false);
    this.reviewing.set(m);
  }

  protected closeReview(): void {
    this.reviewing.set(null);
  }

  /** A clear licence downloads at once; any other opens the acceptance dialog. */
  protected start(m: KaraokeModel): void {
    if (m.licence.clear) void this.download(m, false);
    else this.review(m);
  }

  protected async confirmDownload(): Promise<void> {
    const m = this.reviewing();
    if (m && this.accepted()) await this.download(m, true);
  }

  private async download(m: KaraokeModel, accept: boolean): Promise<void> {
    this.reviewing.set(null);
    await this.act(m.id, () => this.api.download(m.id, accept));
  }

  protected verify(m: KaraokeModel): Promise<void> {
    return this.act(m.id, () => this.api.verifyModel(m.id));
  }

  protected cancel(m: KaraokeModel): Promise<void> {
    return this.act(m.id, () => this.api.deleteModel(m.id));
  }

  protected async remove(m: KaraokeModel): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('karaoke.admin.delete_title', { name: m.name }),
      message: this.translate.instant('karaoke.admin.delete_message'),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (ok) await this.act(m.id, () => this.api.deleteModel(m.id));
  }

  protected async removeOrphan(o: KaraokeOrphan): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('karaoke.admin.orphan_delete_title', { name: o.name }),
      message: this.translate.instant('karaoke.admin.orphan_delete_message', { size: formatBytes(o.sizeBytes) }),
      confirmLabel: this.translate.instant('common.delete'),
      variant: 'danger',
    });
    if (ok) await this.act(o.name, () => this.api.deleteOrphan(o.name));
  }

  protected installSelection(): Promise<void> {
    return this.act('selection', () => Promise.all(this.selection().map((m) => this.api.download(m.id, false))));
  }

  protected async choose(l: KaraokeLanguage, id: string): Promise<void> {
    const next = { ...this.aligners(), [l.language]: id };
    try {
      await this.settingsApi.setBulk({ 'karaoke.aligners': JSON.stringify(next) });
      this.aligners.set(next);
      this.toast.success(this.translate.instant('karaoke.admin.saved'));
      await this.refreshLanguages();
    } catch {
      // The interceptor toasts the reason.
    }
  }

  protected async resync(): Promise<void> {
    this.resyncing.set(true);
    try {
      await this.api.realign();
    } catch {
      this.resyncing.set(false);
    }
  }

  /** Runs one action on `key` (a model id, an orphan name), then asks for a fresh catalogue. */
  private async act(key: string, run: () => Promise<unknown>): Promise<void> {
    this.busy.set(key);
    try {
      await run();
      this.reload.emit();
    } catch {
      // The interceptor toasts the reason.
    } finally {
      this.busy.set(null);
    }
  }
}

function parseAligners(raw: string | null | undefined): Record<string, string> {
  try {
    const v: unknown = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
