import {
  Component,
  ElementRef,
  computed,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TvSelectDirective } from '../../../shared/directives/tv-select.directive';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  AutoApprovalApiService,
  AutoApprovalCriteria,
  AutoApprovalRule,
} from '../../../core/services/api/auto-approval-api.service';
import { UsersApiService, UserRow } from '../../../core/services/api/users-api.service';
import { RolesApiService, RoleRow } from '../../../core/services/api/roles-api.service';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';
import { MetadataService, TmdbGenre } from '../../../core/services/api/metadata.service';
import {
  MultiSelectComponent,
  MultiSelectOption,
} from '../../../shared/components/forms/multi-select/multi-select';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';

type RuleMediaType = '' | 'movie' | 'series';

@Component({
  selector: 'app-auto-approval',
  imports: [TvSelectDirective, 
    ModalFooterComponent,
    ModalHeaderComponent,
    MultiSelectComponent,
    FormsModule,
    TranslatePipe,
  ],
  templateUrl: './auto-approval.html',
})
export class AutoApprovalSettingsComponent implements OnInit {
  private readonly api = inject(AutoApprovalApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly rolesApi = inject(RolesApiService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly metadata = inject(MetadataService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly rules = signal<AutoApprovalRule[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  readonly users = signal<UserRow[]>([]);
  readonly roles = signal<RoleRow[]>([]);
  readonly libraries = signal<Library[]>([]);
  private readonly movieGenres = signal<TmdbGenre[]>([]);
  private readonly tvGenres = signal<TmdbGenre[]>([]);

  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  readonly saving = signal(false);
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formEnabled = signal(true);
  readonly formUserIds = signal<number[]>([]);
  readonly formRoleIds = signal<number[]>([]);
  readonly formMediaType = signal<RuleMediaType>('');
  readonly formLibraryIds = signal<number[]>([]);
  readonly formGenreIds = signal<number[]>([]);
  readonly formMaxSeasons = signal<number | null>(null);
  readonly formYearFrom = signal<number | null>(null);
  readonly formYearTo = signal<number | null>(null);

  /** Genre list follows the media type: a movie-only rule can't match a TV genre. */
  readonly genres = computed(() => {
    const type = this.formMediaType();
    if (type === 'movie') return this.movieGenres();
    if (type === 'series') return this.tvGenres();
    const byId = new Map<number, TmdbGenre>();
    for (const g of [...this.movieGenres(), ...this.tvGenres()]) byId.set(g.id, g);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly userOptions = computed<MultiSelectOption[]>(() =>
    this.users().map((u) => ({ value: u.id, label: u.username })),
  );
  readonly roleOptions = computed<MultiSelectOption[]>(() =>
    this.roles().map((r) => ({ value: r.id, label: r.name })),
  );
  readonly libraryOptions = computed<MultiSelectOption[]>(() =>
    this.libraries().map((l) => ({ value: l.id, label: l.name })),
  );
  readonly genreOptions = computed<MultiSelectOption[]>(() =>
    this.genres().map((g) => ({ value: g.id, label: g.name })),
  );

  /** A rule with nothing set approves every request — worth saying out loud. */
  readonly matchesEverything = computed(
    () =>
      this.formUserIds().length === 0 &&
      this.formRoleIds().length === 0 &&
      this.formMediaType() === '' &&
      this.formLibraryIds().length === 0 &&
      this.formGenreIds().length === 0 &&
      this.formMaxSeasons() == null &&
      this.formYearFrom() == null &&
      this.formYearTo() == null,
  );

  ngOnInit() {
    void this.reload();
    void this.loadPickers();
  }

  async reload() {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.rules.set(await this.api.list());
    } catch {
      this.listError.set(this.translate.instant('settings.auto_approval.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadPickers() {
    const [users, roles, libraries, movieGenres, tvGenres] = await Promise.all([
      this.usersApi.list().catch(() => []),
      this.rolesApi.list().catch(() => []),
      this.librariesApi.list().catch(() => []),
      this.metadata.getMovieGenres().catch(() => []),
      this.metadata.getTvGenres().catch(() => []),
    ]);
    this.users.set(users);
    this.roles.set(roles);
    this.libraries.set(libraries);
    this.movieGenres.set(movieGenres);
    this.tvGenres.set(tvGenres);
  }

  /** Human-readable chips for the list row, so a rule reads without opening it. */
  summary(rule: AutoApprovalRule): string[] {
    const c = rule.criteria;
    const chips: string[] = [];
    const names = (ids: number[] | undefined, lookup: Map<number, string>) =>
      (ids ?? []).map((id) => lookup.get(id) ?? `#${id}`);

    const who = [
      ...names(c.userIds, new Map(this.users().map((u) => [u.id, u.username]))),
      ...names(c.roleIds, new Map(this.roles().map((r) => [r.id, r.name]))),
    ];
    chips.push(
      who.length
        ? who.join(', ')
        : this.translate.instant('settings.auto_approval.summary_everyone'),
    );
    if (c.mediaType)
      chips.push(this.translate.instant(`settings.auto_approval.media_type_${c.mediaType}`));
    chips.push(...names(c.libraryIds, new Map(this.libraries().map((l) => [l.id, l.name]))));
    chips.push(...names(c.genreIds, new Map(this.genresById())));
    if (c.maxSeasons != null)
      chips.push(
        this.translate.instant('settings.auto_approval.summary_max_seasons', {
          count: c.maxSeasons,
        }),
      );
    if (c.yearFrom != null || c.yearTo != null)
      chips.push(`${c.yearFrom ?? '…'} – ${c.yearTo ?? '…'}`);
    return chips;
  }

  private genresById(): [number, string][] {
    return [...this.movieGenres(), ...this.tvGenres()].map((g) => [g.id, g.name]);
  }

  openCreate() {
    this.editingId.set(null);
    this.resetForm({});
    this.formName.set('');
    this.formEnabled.set(true);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(rule: AutoApprovalRule) {
    this.editingId.set(rule.id);
    this.formName.set(rule.name);
    this.formEnabled.set(rule.enabled);
    this.resetForm(rule.criteria ?? {});
    this.editorDialog()?.nativeElement.showModal();
  }

  private resetForm(c: AutoApprovalCriteria) {
    this.formUserIds.set([...(c.userIds ?? [])]);
    this.formRoleIds.set([...(c.roleIds ?? [])]);
    this.formMediaType.set(c.mediaType ?? '');
    this.formLibraryIds.set([...(c.libraryIds ?? [])]);
    this.formGenreIds.set([...(c.genreIds ?? [])]);
    this.formMaxSeasons.set(c.maxSeasons ?? null);
    this.formYearFrom.set(c.yearFrom ?? null);
    this.formYearTo.set(c.yearTo ?? null);
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  setMediaType(value: RuleMediaType) {
    this.formMediaType.set(value);
    if (value === 'movie') this.formMaxSeasons.set(null);
    // Genre ids are type-scoped: drop any that the new list no longer offers.
    const allowed = new Set(this.genres().map((g) => g.id));
    this.formGenreIds.update((ids) => ids.filter((id) => allowed.has(id)));
  }

  setNumber(which: 'maxSeasons' | 'yearFrom' | 'yearTo', raw: string) {
    const sig = {
      maxSeasons: this.formMaxSeasons,
      yearFrom: this.formYearFrom,
      yearTo: this.formYearTo,
    }[which];
    const parsed = Number.parseInt(raw, 10);
    sig.set(Number.isFinite(parsed) ? parsed : null);
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    this.saving.set(true);
    const criteria: AutoApprovalCriteria = {};
    if (this.formUserIds().length) criteria.userIds = this.formUserIds();
    if (this.formRoleIds().length) criteria.roleIds = this.formRoleIds();
    if (this.formMediaType()) criteria.mediaType = this.formMediaType() as 'movie' | 'series';
    if (this.formLibraryIds().length) criteria.libraryIds = this.formLibraryIds();
    if (this.formGenreIds().length) criteria.genreIds = this.formGenreIds();
    if (this.formMaxSeasons() != null) criteria.maxSeasons = this.formMaxSeasons()!;
    if (this.formYearFrom() != null) criteria.yearFrom = this.formYearFrom()!;
    if (this.formYearTo() != null) criteria.yearTo = this.formYearTo()!;

    const body = { name, enabled: this.formEnabled(), criteria };
    const id = this.editingId();
    try {
      await (id != null ? this.api.update(id, body) : this.api.create(body));
      this.closeEditor();
      await this.reload();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async remove(rule: AutoApprovalRule) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.auto_approval.confirm_delete', {
          name: rule.name,
        }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.remove(rule.id);
      this.rules.update((list) => list.filter((r) => r.id !== rule.id));
    } catch {
      // handled by global error interceptor
    }
  }
}
