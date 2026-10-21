import { Component, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  CleanupAction,
  CleanupApiService,
  CleanupCandidate,
  CleanupCriteria,
  CleanupLevel,
  CleanupPreview,
  CleanupRule,
  CleanupRuleBody,
  CleanupScope,
} from '../../../core/services/api/cleanup-api.service';
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
  private readonly settings = inject(SettingsApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly metadata = inject(MetadataService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  protected readonly formatBytes = formatBytes;
  protected readonly daysLeft = daysLeft;
  protected readonly scopeLabel = scopeLabel;
  protected readonly levels: CleanupLevel[] = ['movie', 'series', 'season', 'episode'];
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
  protected readonly scopedLevels: CleanupLevel[] = ['season', 'episode'];
  protected readonly flagFields: FlagKey[] = [
    'neverPlayed',
    'watchedByRequester',
    'seriesEnded',
    'notLiked',
    'notLikedByRequester',
  ];

  readonly rules = signal<CleanupRule[]>([]);
  readonly candidates = signal<CleanupCandidate[]>([]);
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
  readonly formLevel = signal<CleanupLevel>('movie');
  readonly formDeleteSeriesWhenEmpty = signal(false);
  readonly formAction = signal<CleanupAction>('delete');
  readonly formGraceDays = signal<number | null>(null);
  readonly formReminderDays = signal('7, 1');
  readonly formCriteria = signal<CleanupCriteria>({});

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
      const [rules, candidates] = await Promise.all([this.api.listRules(), this.api.candidates()]);
      this.rules.set(rules);
      this.candidates.set(candidates);
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
    this.fill('', true, 'movie', false, 'delete', null, [7, 1], {});
  }

  openEdit(rule: CleanupRule) {
    this.editingId.set(rule.id);
    this.fill(
      rule.name,
      rule.enabled,
      rule.level,
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
    level: CleanupLevel,
    deleteSeriesWhenEmpty: boolean,
    action: CleanupAction,
    grace: number | null,
    reminders: number[],
    c: CleanupCriteria,
  ) {
    this.formName.set(name);
    this.formEnabled.set(enabled);
    this.formLevel.set(level);
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

  setList<K extends 'libraryIds' | 'genres' | 'excludeGenres'>(key: K, value: CleanupCriteria[K]) {
    this.formCriteria.update((c) => ({ ...c, [key]: value }));
  }

  /** Drops the criteria the new level rejects: the type below the media, `keepLatestEpisodes` off episodes. */
  setLevel(level: CleanupLevel) {
    this.formLevel.set(level);
    this.formCriteria.update(({ mediaType, keepLatestEpisodes, ...rest }) => ({
      ...rest,
      ...(level === 'movie' || level === 'series' ? { mediaType: mediaType === level ? mediaType : undefined } : {}),
      ...(level === 'episode' ? { keepLatestEpisodes } : {}),
    }));
    if (level !== 'season' && level !== 'episode') this.formDeleteSeriesWhenEmpty.set(false);
  }

  setMediaType(value: string) {
    this.formCriteria.update((c) => ({ ...c, mediaType: (value as 'movie' | 'series') || undefined }));
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    this.saving.set(true);
    const body: CleanupRuleBody = {
      name,
      enabled: this.formEnabled(),
      level: this.formLevel(),
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
    const { name, level, criteria, action, graceDays, deleteSeriesWhenEmpty, reminderDays } = rule;
    try {
      await this.api.updateRule(rule.id, {
        name,
        level,
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
}
