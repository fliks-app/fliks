import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { ToastService } from '../../../core/services/toast.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  CleanupAction,
  CleanupApiService,
  CleanupCandidate,
  CleanupCriteria,
  CleanupLevel,
  CleanupPreview,
  CleanupReason,
  CleanupRecommendations,
  CleanupRule,
  CleanupRuleBody,
  CleanupScope,
} from '../../../core/services/api/cleanup-api.service';
import { MediaService } from '../../../core/services/api/media.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';
import { MetadataService } from '../../../core/services/api/metadata.service';
import {
  MultiSelectComponent,
  MultiSelectOption,
} from '../../../shared/components/forms/multi-select/multi-select';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { EnabledSwitchComponent } from '../../../shared/components/enabled-switch';
import { formatBytes } from '../../../shared/utils/download-format';
import { cleanCriteria, daysLeft, scopeLabel } from '../../../shared/utils/cleanup.util';

type NumberKey = {
  [K in keyof CleanupCriteria]-?: CleanupCriteria[K] extends number | undefined ? K : never;
}[keyof CleanupCriteria];
type FlagKey = {
  [K in keyof CleanupCriteria]-?: CleanupCriteria[K] extends boolean | undefined ? K : never;
}[keyof CleanupCriteria];

const MAX_PER_RUN_KEY = 'cleanup_max_per_run';

@Component({
  selector: 'app-cleanup',
  imports: [
    TvSelectDirective,
    ModalFooterComponent,
    ModalHeaderComponent,
    MultiSelectComponent,
    FormsModule,
    DatePipe,
    TranslatePipe,
    EnabledSwitchComponent,
  ],
  templateUrl: './cleanup.html',
})
export class CleanupSettingsComponent implements OnInit {
  private readonly api = inject(CleanupApiService);
  private readonly mediaApi = inject(MediaService);
  private readonly settings = inject(SettingsApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly metadata = inject(MetadataService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);

  protected readonly formatBytes = formatBytes;
  protected readonly daysLeft = daysLeft;
  protected readonly scopeLabel = scopeLabel;
  protected readonly levelOptions = computed<MultiSelectOption<CleanupLevel>[]>(() =>
    (['movie', 'series', 'season', 'episode'] as const).map((value) => ({
      value,
      label: this.translate.instant('settings.cleanup.applies_' + value),
    })),
  );
  protected readonly actions: CleanupAction[] = ['delete', 'delete_files_unmonitor', 'none'];
  protected readonly numberFields: NumberKey[] = [
    'addedOlderThanDays',
    'releasedOlderThanDays',
    'lastPlayedOlderThanDays',
    'ratingBelow',
    'minVotes',
    'sizeAboveGb',
    'playCountBelow',
    'playCountByUsersBelow',
    'notPlayedInLastDays',
    'likedByFewerThan',
    'diskFreeBelowPercent',
  ];
  protected readonly flagFields: FlagKey[] = [
    'neverPlayed',
    'watchedByRequester',
    'seriesEnded',
    'notLiked',
    'notLikedByRequester',
  ];

  readonly rules = signal<CleanupRule[]>([]);
  readonly candidates = signal<CleanupCandidate[]>([]);
  readonly recommendations = signal<CleanupRecommendations>({ reasons: [], items: [] });
  readonly loading = signal(true);
  readonly libraries = signal<Library[]>([]);
  readonly genreOptions = signal<MultiSelectOption<string>[]>([]);
  readonly libraryOptions = computed<MultiSelectOption[]>(() =>
    this.libraries().map((l) => ({ value: l.id, label: l.name })),
  );

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly previewDialog = viewChild<ElementRef<HTMLDialogElement>>('previewDialog');
  readonly saving = signal(false);
  readonly togglingId = signal<number | null>(null);
  readonly editingId = signal<number | null>(null);
  readonly preview = signal<(CleanupPreview & { name: string }) | null>(null);

  readonly formName = signal('');
  readonly formEnabled = signal(true);
  readonly formLevels = signal<CleanupLevel[]>(['movie']);
  protected readonly formScoped = computed(() => this.formLevels().some((l) => l === 'season' || l === 'episode'));
  protected readonly formEpisodeOnly = computed(() => this.formLevels().join() === 'episode');
  readonly formDeleteSeriesWhenEmpty = signal(false);
  readonly formAction = signal<CleanupAction>('delete');
  readonly formGraceDays = signal<number | null>(null);
  readonly formReminderDays = signal('7, 1');
  readonly formCriteria = signal<CleanupCriteria>({});

  readonly selected = signal<ReadonlySet<number>>(new Set());
  readonly selectedCandidates = computed(() => this.candidates().filter((c) => this.selected().has(c.id)));
  readonly selectedSize = computed(() => this.selectedCandidates().reduce((n, c) => n + c.size, 0));
  readonly allSelected = computed(
    () => this.candidates().length > 0 && this.selectedCandidates().length === this.candidates().length,
  );
  readonly bulkBusy = signal(false);

  readonly maxPerRun = signal<number | null>(10);

  ngOnInit() {
    void this.reload();
    void this.loadPickers();
    void this.settings.get(MAX_PER_RUN_KEY).then(
      (s) => s.value != null && this.maxPerRun.set(Number(s.value)),
      () => undefined,
    );
  }

  async reload() {
    this.loading.set(true);
    try {
      const [rules, candidates, recommendations] = await Promise.all([
        this.api.listRules(),
        this.api.candidates(),
        this.api.recommendations(),
      ]);
      this.rules.set(rules);
      this.candidates.set(candidates);
      this.recommendations.set(recommendations);
      this.selected.set(new Set());
    } catch {
      // handled by global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  private async loadPickers() {
    const [libraries, movie, tv] = await Promise.all([
      this.librariesApi.list().catch(() => []),
      this.metadata.getMovieGenres().catch(() => []),
      this.metadata.getTvGenres().catch(() => []),
    ]);
    this.libraries.set(libraries);
    const names = [...new Set([...movie, ...tv].map((g) => g.name))].sort((a, b) => a.localeCompare(b));
    this.genreOptions.set(names.map((n) => ({ value: n, label: n })));
  }

  libraryNames(rule: CleanupRule): string {
    const byId = new Map(this.libraries().map((l) => [l.id, l.name]));
    return (rule.criteria.libraryIds ?? []).map((id) => byId.get(id) ?? `#${id}`).join(', ');
  }

  openCreate() {
    this.editingId.set(null);
    this.fill('', true, ['movie'], false, 'delete', null, [7, 1], {});
  }

  openEdit(rule: CleanupRule) {
    this.editingId.set(rule.id);
    this.fill(
      rule.name,
      rule.enabled,
      rule.levels,
      rule.deleteSeriesWhenEmpty,
      rule.action,
      rule.graceDays,
      rule.reminderDays,
      rule.criteria ?? {},
    );
  }

  private fill(
    name: string,
    enabled: boolean,
    levels: CleanupLevel[],
    deleteSeriesWhenEmpty: boolean,
    action: CleanupAction,
    grace: number | null,
    reminders: number[],
    c: CleanupCriteria,
  ) {
    this.formName.set(name);
    this.formEnabled.set(enabled);
    this.formLevels.set(levels);
    this.formDeleteSeriesWhenEmpty.set(deleteSeriesWhenEmpty);
    this.formAction.set(action);
    this.formGraceDays.set(grace);
    this.formReminderDays.set(reminders.join(', '));
    this.formCriteria.set({ ...c });
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  parseNumber(raw: string | number | null): number | null {
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  setNumber(key: NumberKey, raw: string | number | null) {
    const n = this.parseNumber(raw);
    this.formCriteria.update((c) => ({ ...c, [key]: n ?? undefined }));
  }

  setFlag(key: FlagKey, on: boolean) {
    this.formCriteria.update((c) => ({ ...c, [key]: on || undefined }));
  }

  setList<K extends 'libraryIds' | 'excludeLibraryIds' | 'genres' | 'excludeGenres'>(key: K, value: CleanupCriteria[K]) {
    this.formCriteria.update((c) => ({ ...c, [key]: value }));
  }

  /** At most one of series, season and episode: the one just picked wins. Drops what the new levels reject. */
  setLevels(picked: CleanupLevel[]) {
    const added = picked.filter((l) => !this.formLevels().includes(l));
    const others = picked.filter((l) => l !== 'movie');
    const kept = others.length > 1 ? others.filter((l) => added.includes(l)) : others;
    const levels: CleanupLevel[] = [...(picked.includes('movie') ? ['movie' as const] : []), ...kept];
    this.formLevels.set(levels.length ? levels : ['movie']);
    if (!this.formEpisodeOnly()) {
      this.formCriteria.update(({ keepLatestEpisodes, ...rest }) => rest);
    }
    if (!this.formScoped()) this.formDeleteSeriesWhenEmpty.set(false);
  }

  levelLabels(rule: CleanupRule): string {
    return rule.levels.map((l) => this.translate.instant('settings.cleanup.applies_' + l)).join(', ');
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    this.saving.set(true);
    const body: CleanupRuleBody = {
      name,
      enabled: this.formEnabled(),
      levels: this.formLevels(),
      deleteSeriesWhenEmpty: this.formDeleteSeriesWhenEmpty(),
      action: this.formAction(),
      graceDays: this.formGraceDays(),
      reminderDays: this.formReminderDays()
        .split(',')
        .filter((d) => d.trim())
        .map(Number),
      criteria: cleanCriteria(this.formCriteria()),
    };
    const id = this.editingId();
    try {
      await (id != null ? this.api.updateRule(id, body) : this.api.createRule(body));
      this.closeEditor();
      await this.reload();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  /** The server replaces the whole rule and rejects unknown keys, so the editable fields ride along with `enabled`. */
  async toggleEnabled(rule: CleanupRule) {
    this.togglingId.set(rule.id);
    const { name, levels, criteria, action, graceDays, deleteSeriesWhenEmpty, reminderDays } = rule;
    try {
      await this.api.updateRule(rule.id, {
        name,
        levels,
        criteria,
        action,
        graceDays,
        deleteSeriesWhenEmpty,
        reminderDays,
        enabled: !rule.enabled,
      });
      await this.reload();
    } catch {
      // handled by global error interceptor
    } finally {
      this.togglingId.set(null);
    }
  }

  async remove(rule: CleanupRule) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.cleanup.confirm_delete', { name: rule.name }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.removeRule(rule.id);
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }

  async runPreview(rule: CleanupRule) {
    try {
      this.preview.set({ ...(await this.api.preview(rule.id)), name: rule.name });
      this.previewDialog()?.nativeElement.showModal();
    } catch {
      // handled by global error interceptor
    }
  }

  closePreview() {
    this.previewDialog()?.nativeElement.close();
  }

  async keep(c: CleanupCandidate) {
    try {
      await this.api.keep(c);
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }

  async keepRecommended(mediaId: number) {
    try {
      await this.api.keepMedia(mediaId);
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }

  async deleteRecommended(item: CleanupRecommendations['items'][number]) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.cleanup.confirm_delete_now', { title: item.title }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.mediaApi.delete(item.mediaId);
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }

  ruleFromReason(key: CleanupReason) {
    const reason = this.recommendations().reasons.find((r) => r.key === key);
    if (!reason) return;
    this.editingId.set(null);
    this.fill(
      this.translate.instant('settings.cleanup.reason_' + key),
      true,
      reason.levels,
      false,
      'delete',
      null,
      [7, 1],
      reason.criteria,
    );
  }

  async deleteNow(c: CleanupCandidate) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.cleanup.confirm_delete_now', {
          title: c.title + scopeLabel(c),
        }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.deleteNow(c);
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }

  async saveMaxPerRun() {
    const n = this.maxPerRun();
    if (n == null || n < 1) return;
    try {
      await this.settings.set(MAX_PER_RUN_KEY, String(Math.floor(n)));
    } catch {
      // handled by global error interceptor
    }
  }

  toggleSelected(id: number) {
    this.selected.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  toggleAll() {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.candidates().map((c) => c.id)));
  }

  async bulk(action: 'keep' | 'delete-now') {
    const picked = this.selectedCandidates();
    if (!picked.length) return;
    if (
      action === 'delete-now' &&
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.cleanup.confirm_bulk_delete', {
          count: picked.length,
          size: formatBytes(this.selectedSize()),
        }),
        variant: 'danger',
      }))
    )
      return;
    this.bulkBusy.set(true);
    try {
      const { results } = await this.api.bulk(action, picked);
      const failed = results.filter((r) => !r.ok).length;
      const done = { size: results.length - failed };
      await this.reload();
      const key = failed ? 'settings.cleanup.bulk_partial' : 'settings.cleanup.bulk_done';
      const msg = this.translate.instant(key, { done: done.size, failed });
      if (failed) this.toast.warning(msg);
      else this.toast.success(msg);
    } catch {
      // handled by global error interceptor
    } finally {
      this.bulkBusy.set(false);
    }
  }

  async exportRule(rule: CleanupRule) {
    try {
      const json = JSON.stringify(await this.api.exportRule(rule.id), null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${rule.name.replace(/[\\/:*?"<>|]+/g, '_')}.fliks-rule.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // handled by global error interceptor
    }
  }

  async onImportPicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      this.toast.error(this.translate.instant('settings.cleanup.import_invalid'));
      return;
    }
    try {
      const rule = await this.api.importRule(body);
      this.toast.success(this.translate.instant('settings.cleanup.imported', { name: rule.name }));
      await this.reload();
    } catch {
      // handled by global error interceptor
    }
  }
}
