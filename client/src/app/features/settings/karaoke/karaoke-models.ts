import { Component, DestroyRef, ElementRef, computed, effect, inject, input, model, output, signal, viewChild } from '@angular/core';
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
  host: { class: 'flex flex-col gap-5' },
})
export class KaraokeModelsComponent {
  private readonly api = inject(KaraokeApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly confirm = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('licence');

  readonly catalogue = input.required<KaraokeModels>();
  /** The admin's `karaoke.aligners` choices, language to model id; the parent read them with the settings. */
  readonly aligners = model.required<Record<string, string>>();
  /** A model or the folder changed: the parent loads the catalogue again. */
  readonly reload = output<void>();

  protected readonly busy = signal<string | null>(null);
  protected readonly reviewing = signal<KaraokeModel | null>(null);
  protected readonly accepted = signal(false);
  protected readonly languages = signal<KaraokeLanguage[]>([]);
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
  protected readonly recommended = computed(() => new Set(this.languages().map((l) => l.recommended)));
  protected readonly selection = computed(() => {
    return this.catalogue().models.filter((m) => this.recommended().has(m.id) && this.notInstalled(m) && m.licence.clear);
  });
  protected readonly selectionSize = computed(() => formatBytes(this.selection().reduce((n, m) => n + m.sizeBytes, 0)));

  constructor() {
    inject(SseService)
      .karaokeEvents.pipe(takeUntilDestroyed())
      .subscribe((e) => {
        if (e.type === 'karaoke.job_changed' && (e['state'] === 'ready' || e['state'] === 'failed')) this.scheduleStale();
      });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.staleTimer));
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

  private async refreshLanguages(): Promise<void> {
    try {
      this.languages.set(await this.api.languages());
    } catch {
      this.languages.set([]);
    }
    await this.refreshStale();
  }

  private staleTimer: ReturnType<typeof setTimeout> | undefined;

  /** A run ends one track at a time: ask once it settles. */
  private scheduleStale(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => void this.refreshStale(), 1500);
  }

  private async refreshStale(): Promise<void> {
    try {
      const { tracks, running } = await this.api.staleTracks();
      this.stale.set(tracks);
      this.resyncing.set(running);
    } catch {
      this.stale.set(0);
      this.resyncing.set(false);
    }
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

  private notInstalled(m: KaraokeModel): boolean {
    return m.state === 'absent' || m.state === 'failed';
  }

  /** Downloads a model that is not installed, or updates an outdated one. */
  protected canDownload(m: KaraokeModel): boolean {
    return this.notInstalled(m) || m.outdated;
  }

  /** Only a download cancels: deleting a model that is being verified would remove installed files. */
  protected canCancel(m: KaraokeModel): boolean {
    return m.state === 'downloading' && !m.verifying;
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
        m.state === 'installed' &&
        (!m.languages.length || m.languages.includes(l.language)),
    );
  }

  /** The recommended aligner of a language, when it is not installed. */
  protected missing(l: KaraokeLanguage): KaraokeModel | undefined {
    const m = this.modelOf(l.recommended);
    return m && this.notInstalled(m) ? m : undefined;
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

  /** An empty `id` is the automatic choice: the override goes. */
  protected async choose(l: KaraokeLanguage, id: string): Promise<void> {
    const kept = Object.entries(this.aligners()).filter(([language]) => language !== l.language);
    const next = Object.fromEntries(id ? [...kept, [l.language, id]] : kept);
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

export function parseAligners(raw: string | null | undefined): Record<string, string> {
  try {
    const v: unknown = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
