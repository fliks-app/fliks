import { ModalComponent } from '../modal';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TranslatePluralPipe } from '../../../core/pipes/translate-plural.pipe';
import type { MediaType } from '../../../core/enums/media-type.enum';
import { kindOf } from '../../../core/media-kinds';
import { allowanceLine } from '../../../core/utils/request-allowance';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { MetadataService, type SeasonStub } from '../../../core/services/api/metadata.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { extractMessage } from '../../../core/interceptors/error.interceptor';
import { RequestsService, type CreateRequestBody, type RequestAllowance } from '../../../core/services/api/requests.service';
import { PushService } from '../../../core/services/push.service';
import type { WantSpec } from '../../../core/services/api/wants-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { LibraryFolderSelectComponent, defaultFolderId } from '../library-folder-select/library-folder-select';
import { ModalFooterComponent } from '../modal-footer';
import { ModalHeaderComponent } from '../modal-header';
import { SeasonPickerComponent } from '../season-picker/season-picker.component';
import { WantsEditorComponent } from '../wants-editor/wants-editor';
import { RequestWantsComponent } from '../../../features/requests/request-wants/request-wants';
import { RequestRequestersComponent } from '../../../features/requests/request-requesters/request-requesters.component';
import {
  type AddRequest,
  type AddResult,
  type Choices,
  type Profile,
  askNothing,
  compatible,
  preselect,
  profileDefaults,
  rememberLibrary,
} from './add-plan';

/** The one way to add or request a provider hit, both a request create: straight away when one library takes
 *  it, else this dialog (library, folder, profiles; seasons for a series; editions for a book). */
@Component({
  selector: 'app-add-dialog',
  imports: [FormsModule, TranslatePipe, TranslatePluralPipe, TvSelectDirective, ModalHeaderComponent, ModalFooterComponent, ModalComponent, SeasonPickerComponent, LibraryFolderSelectComponent, WantsEditorComponent, RequestWantsComponent, RequestRequestersComponent],
  templateUrl: './add-dialog.html',
})
export class AddDialogComponent {
  private readonly auth = inject(AuthService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly metadata = inject(MetadataService);
  private readonly requestsApi = inject(RequestsService);
  private readonly push = inject(PushService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialogEl = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });

  readonly done = output<AddResult>();
  /** The add ended without being made: the dialog was dismissed or the request failed. */
  readonly cancelled = output<void>();
  private settled = false;

  protected readonly req = signal<AddRequest | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly choices = signal<Choices>({ libraries: [], quality: [], language: [], wantQuality: [] });
  protected readonly libraryId = signal<number | null>(null);
  protected readonly folderId = signal<number | null>(null);
  protected readonly qualityId = signal<number | null>(null);
  protected readonly languageId = signal<number | null>(null);
  protected readonly wants = signal<WantSpec[]>([{ family: 'text', language: null }]);
  protected readonly audioQualityId = signal<number | null>(null);
  protected readonly seasons = signal<SeasonStub[]>([]);
  protected readonly selectedSeasons = signal<Set<number>>(new Set());
  protected readonly seasonsLoading = signal(false);
  protected readonly seasonsFailed = signal(false);
  private readonly followOverride = signal<boolean | null>(null);
  /** Preset: no season picked, or the picked ones include the latest known season; the user's tick wins. */
  protected readonly followNewSeasons = computed(() => {
    const picked = this.selectedSeasons();
    const latest = Math.max(...this.seasons().map((s) => s.seasonNumber), 0);
    return this.followOverride() ?? (picked.size === 0 || picked.has(latest));
  });
  private readonly allowances = signal<RequestAllowance | null>(null);
  protected readonly kind = computed<MediaType>(() => this.req()?.kind ?? 'movie');
  /** The create is certain to be approved: the dialog says "Add". */
  protected readonly auto = computed(() => this.requestsApi.autoKinds().has(this.kind()));
  protected readonly canManage = computed(() => this.auth.hasPermission('requests.manage'));
  protected readonly hasSeasons = computed(() => kindOf(this.kind()).hasSeasons);
  protected readonly isVideo = computed(() => this.kind() === 'movie' || this.kind() === 'series');
  protected readonly libraries = computed(() => compatible(this.choices().libraries, this.kind()));
  protected readonly folders = computed(() => this.libraries().find((l) => l.id === this.libraryId())?.folders ?? []);
  /** An approved add absorbs pending seasons and skips held ones, so nothing is locked for it. */
  protected readonly alreadyRequested = computed(() => new Set(this.auto() ? [] : (this.req()?.alreadyRequestedSeasons ?? [])));
  protected readonly showFollow = computed(() => this.hasSeasons() && !this.req()?.followsNewSeasons);
  protected readonly locked = computed(() => !!this.req()?.profilesLocked);
  protected readonly qualityLocked = computed(() => this.locked() && this.req()?.lockedQualityProfileId != null);
  /** Folder and profile pickers are for who adds or manages; a member's request takes the library defaults. */
  protected readonly canChoose = computed(() => this.canManage() || this.auth.hasPermission('media.create'));
  protected readonly noLibrary = computed(() => !this.loading() && this.libraries().length === 0);
  protected readonly nothingPicked = computed(() => this.hasSeasons() && !this.seasonsFailed() && this.selectedSeasons().size === 0);
  protected readonly wantsReady = computed(() => this.wants().every((w) => w.qualityProfileId != null));
  /** The member's remaining requests of this kind; none without a limit. */
  protected readonly allowance = computed(() => {
    const a = this.allowances()?.[this.kind()];
    return a ? allowanceLine(this.translate, a) : null;
  });
  protected readonly canSubmit = computed(() => {
    if (this.allowance()?.blocked) return false;
    if (this.busy() || this.loading() || this.noLibrary() || this.seasonsLoading() || this.nothingPicked()) return false;
    if (this.isVideo()) return !this.canChoose() || this.qualityId() != null;
    if (this.kind() === 'book') return this.wantsReady();
    return this.audioQualityId() != null;
  });
  protected readonly titleKey = computed(() => {
    const r = this.req();
    if (!r) return 'discover.add_title';
    if (this.kind() === 'album') return this.auto() ? 'discover.add_music' : 'discover.request_music';
    return this.auto() ? 'discover.add_title' : 'discover.request_title';
  });
  protected readonly confirmKey = computed(() => {
    if (this.auto()) return 'discover.add_to_library';
    if (this.hasSeasons()) return 'discover.select_seasons';
    return this.kind() === 'album' && !this.req()?.recording ? 'discover.request_album' : 'discover.request';
  });

  /** False while an add loads or submits: a second `add()` would replace its request. */
  get idle(): boolean {
    return !this.loading() && !this.busy();
  }

  /** Adds the hit without a question when one library takes it, else opens the dialog. */
  async add(req: AddRequest): Promise<void> {
    if (!this.idle) return;
    this.begin(req);
    if (!(await this.load(req))) {
      this.show();
      return;
    }
    if (askNothing(req, this.choices())) {
      await this.submit();
      if (!this.settled) this.cancelled.emit();
      return;
    }
    this.show();
  }

  private begin(req: AddRequest) {
    this.settled = false;
    this.req.set(req);
    this.busy.set(false);
    this.loadFailed.set(false);
    this.libraryId.set(null);
    this.folderId.set(null);
    this.qualityId.set(null);
    this.languageId.set(null);
    this.audioQualityId.set(null);
    this.seasons.set([]);
    this.selectedSeasons.set(new Set());
    this.seasonsFailed.set(false);
    this.followOverride.set(req.pending?.monitorNewSeasons ?? null);
    this.wants.set([{ family: 'text', language: null }]);
    this.allowances.set(null);
  }

  private show() {
    const r = this.req()!;
    this.dialogEl()?.nativeElement.showModal();
    if (this.hasSeasons()) this.loadSeasons(r);
  }

  /** Libraries and the profiles the kind needs; false when they did not load. */
  private async load(r: AddRequest): Promise<boolean> {
    this.loading.set(true);
    try {
      const video = r.kind === 'movie' || r.kind === 'series';
      const family = r.kind === 'book' ? 'text' : 'audio';
      const [libraries, quality, language, wantQuality, allowances] = await Promise.all([
        this.librariesApi.listMine(),
        video ? this.profilesApi.getQualityProfiles() : Promise.resolve([]),
        video ? this.profilesApi.getLanguageProfiles() : Promise.resolve([]),
        video ? Promise.resolve([]) : this.profilesApi.getQualityProfiles(family),
        this.requestsApi.allowance(),
      ]);
      this.allowances.set(allowances);
      const pairs = (l: Profile[]) => l.map((p) => ({ id: p.id, name: p.name }));
      this.choices.set({ libraries, quality: pairs(quality), language: pairs(language), wantQuality: pairs(wantQuality) });
      if (r.kind === 'book') this.wants.set([{ family: 'text', language: null, qualityProfileId: wantQuality[0]?.id ?? null }]);
      this.pick(libraries.find((l) => l.id === r.pending?.libraryId) ?? preselect(libraries, r.kind));
      if (r.pending?.qualityProfileId != null && !this.qualityLocked()) this.qualityId.set(r.pending.qualityProfileId);
      if (r.pending?.languageProfileId != null && !this.locked()) this.languageId.set(r.pending.languageProfileId);
      return true;
    } catch {
      this.loadFailed.set(true);
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  /** A library: its folder and the profiles it defaults to, a profile the viewer already moved is left. */
  private pick(lib: LibrarySummary | null) {
    const r = this.req();
    const before = profileDefaults(this.libraries().find((l) => l.id === this.libraryId()) ?? null, this.choices());
    const d = profileDefaults(lib, this.choices());
    this.libraryId.set(lib?.id ?? null);
    this.folderId.set(defaultFolderId(lib?.folders));
    const locked = this.locked();
    if (!(locked && this.qualityLocked()) && (this.qualityId() == null || this.qualityId() === before.quality)) this.qualityId.set(d.quality);
    if (!locked && (this.languageId() == null || this.languageId() === before.language)) this.languageId.set(d.language);
    if (r && locked && this.qualityLocked()) this.qualityId.set(r.lockedQualityProfileId ?? null);
    if (r && locked) this.languageId.set(r.lockedLanguageProfileId ?? null);
    if (this.audioQualityId() == null) this.audioQualityId.set(d.want);
  }

  protected selectLibrary(id: number | null) {
    this.pick(this.libraries().find((l) => l.id === id) ?? null);
  }

  /** An add ticks the pending row's seasons, else every regular one; a request ticks only what the caller said. */
  private loadSeasons(r: AddRequest) {
    this.seasonsLoading.set(true);
    const pre = new Set(r.pending?.seasons ?? r.preselectedSeasons ?? []);
    this.metadata
      .getSeasonStubs(r.provider, r.externalId)
      .then((stubs) => {
        this.seasons.set(stubs);
        const taken = this.alreadyRequested();
        const all = stubs.map((s) => s.seasonNumber);
        const ticked =
          this.auto() && !r.pending?.seasons?.length
            ? all.filter((n) => n > 0)
            : all.filter((n) => pre.has(n) && !taken.has(n));
        this.selectedSeasons.set(new Set(ticked));
      })
      .catch(() => this.seasonsFailed.set(true))
      .finally(() => this.seasonsLoading.set(false));
  }

  protected toggleFollowNewSeasons() {
    this.followOverride.set(!this.followNewSeasons());
  }

  protected toggleSeason(n: number) {
    this.selectedSeasons.update((set) => {
      const next = new Set(set);
      if (!next.delete(n)) next.add(n);
      return next;
    });
  }

  protected toggleAllSeasons() {
    const taken = this.alreadyRequested();
    const all = this.seasons().map((s) => s.seasonNumber).filter((n) => !taken.has(n));
    this.selectedSeasons.set(this.selectedSeasons().size === all.length ? new Set() : new Set(all));
  }

  protected dismissed() {
    if (!this.settled) this.cancelled.emit();
  }

  protected close() {
    this.dialogEl()?.nativeElement.close();
  }

  protected async submit(): Promise<void> {
    const r = this.req();
    if (!r || !this.canSubmit()) return;
    this.busy.set(true);
    try {
      const row = await this.requestsApi.create(this.body(r), true);
      const recordings = r.kind === 'album' && r.recording ? [r.recording.externalId] : undefined;
      this.settled = true;
      rememberLibrary(r.kind, this.libraryId());
      if (row.status !== 'pending') {
        this.toast.success(this.translate.instant('discover.request_approved'));
      } else if (this.auto()) {
        this.toast.info(this.translate.instant('discover.request_sent_for_approval'));
        void this.requestsApi.reloadAutoKinds();
      } else {
        this.toast.success(this.translate.instant('discover.request_success'));
      }
      this.close();
      this.done.emit({ status: row.status, mediaId: row.mediaId ?? null, ...(recordings ? { recordings } : {}) });
      if (row.status === 'pending') void this.push.askInContext('request');
    } catch (e) {
      if (e instanceof HttpErrorResponse) this.toast.error(extractMessage(e, this.translate));
    } finally {
      this.busy.set(false);
    }
  }

  private place() {
    const folderId = this.folderId();
    return {
      ...(this.libraryId() != null ? { libraryId: this.libraryId()! } : {}),
      ...(this.folders().length > 1 && folderId != null ? { folderId } : {}),
    };
  }

  private audioWants(): WantSpec[] | undefined {
    const q = this.audioQualityId();
    return q == null ? undefined : [{ family: 'audio', language: null, qualityProfileId: q }];
  }

  private readyWants(): (WantSpec & { qualityProfileId: number })[] {
    const d = this.choices().wantQuality[0]?.id ?? null;
    return this.wants().flatMap((w) => {
      const q = w.qualityProfileId ?? d;
      return q == null ? [] : [{ ...w, qualityProfileId: q }];
    });
  }

  private body(r: AddRequest): CreateRequestBody {
    const place = this.place();
    if (r.kind === 'book') return { mediaType: 'book', externalId: r.externalId, title: r.title, wants: this.readyWants(), ...place };
    if (r.kind === 'album') {
      return { mediaType: 'album', externalId: r.externalId, title: r.title, wants: this.audioWants() ?? [], ...(r.recording ? { recordings: [r.recording.externalId] } : {}), ...place };
    }
    return {
      mediaType: r.kind as 'movie' | 'series',
      ...(r.titleKey ?? (r.provider === 'tmdb' ? { tmdbId: Number(r.externalId) } : { provider: r.provider, externalId: r.externalId })),
      title: r.title,
      ...(this.canChoose() ? { qualityProfileId: this.qualityId() ?? undefined, languageProfileId: this.languageId() ?? undefined } : {}),
      ...place,
      ...this.seasonScope(),
      ...(this.showFollow() ? { monitorNewSeasons: this.followNewSeasons() } : {}),
    };
  }

  /** Every regular season and no special is the whole series: no `seasons`. */
  private seasonScope(): { seasons?: number[] } {
    const picked = this.selectedSeasons();
    if (!this.hasSeasons() || this.seasonsFailed() || picked.size === 0) return {};
    const regular = this.seasons().map((s) => s.seasonNumber).filter((n) => n > 0);
    const whole = regular.length > 0 && regular.every((n) => picked.has(n)) && [...picked].every((n) => n > 0);
    return whole ? {} : { seasons: [...picked].sort((a, b) => a - b) };
  }
}
