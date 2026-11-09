import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { MediaType } from '../../../core/enums/media-type.enum';
import { kindOf } from '../../../core/media-kinds';
import { BooksApiService } from '../../../core/services/api/books-api.service';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { MetadataService, type SeasonStub } from '../../../core/services/api/metadata.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import type { AlbumPreviewTrack } from '../../../core/services/api/music.models';
import { formatDuration } from '../../../features/music/music-utils';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { RequestsService, type CreateRequestBody } from '../../../core/services/api/requests.service';
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
import {
  type AddMode,
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

/** The one way to add a provider hit to a library, or to request it: straight away when one library takes
 *  it, else this dialog (library, folder, profiles; seasons for a series; editions for a book). */
@Component({
  selector: 'app-add-dialog',
  imports: [FormsModule, TranslatePipe, TvSelectDirective, ModalHeaderComponent, ModalFooterComponent, SeasonPickerComponent, LibraryFolderSelectComponent, WantsEditorComponent, RequestWantsComponent],
  templateUrl: './add-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddDialogComponent {
  private readonly auth = inject(AuthService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly metadata = inject(MetadataService);
  private readonly books = inject(BooksApiService);
  private readonly music = inject(MusicApiService);
  private readonly requestsApi = inject(RequestsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly dialogEl = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  readonly done = output<AddResult>();

  protected readonly req = signal<AddRequest | null>(null);
  protected readonly mode = signal<AddMode>('import');
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
  protected readonly tracks = signal<AlbumPreviewTrack[]>([]);
  protected readonly selectedTracks = signal<Set<string>>(new Set());
  protected readonly tracksLoading = signal(false);
  protected readonly tracksFailed = signal(false);
  private tracksSeq = 0;
  protected readonly formatDuration = formatDuration;

  /** An album added whole lets the tracks to monitor be picked; a single wanted track or a request does not. */
  protected readonly picksTracks = computed(() => this.kind() === 'album' && this.mode() === 'import' && !this.req()?.recording);
  protected readonly kind = computed<MediaType>(() => this.req()?.kind ?? 'movie');
  protected readonly hasSeasons = computed(() => kindOf(this.kind()).hasSeasons);
  protected readonly isVideo = computed(() => this.kind() === 'movie' || this.kind() === 'series');
  protected readonly libraries = computed(() => compatible(this.choices().libraries, this.kind()));
  protected readonly folders = computed(() => this.libraries().find((l) => l.id === this.libraryId())?.folders ?? []);
  protected readonly alreadyRequested = computed(() => new Set(this.req()?.alreadyRequestedSeasons ?? []));
  protected readonly locked = computed(() => !!this.req()?.profilesLocked);
  protected readonly qualityLocked = computed(() => this.locked() && this.req()?.lockedQualityProfileId != null);
  protected readonly noLibrary = computed(() => !this.loading() && this.libraries().length === 0);
  protected readonly nothingPicked = computed(() => this.hasSeasons() && !this.seasonsFailed() && this.selectedSeasons().size === 0);
  protected readonly wantsReady = computed(() => this.wants().every((w) => w.qualityProfileId != null));
  protected readonly canSubmit = computed(() => {
    if (this.busy() || this.loading() || this.noLibrary() || this.seasonsLoading() || this.nothingPicked()) return false;
    if (this.isVideo()) return this.qualityId() != null;
    if (this.kind() === 'book') return this.wantsReady();
    if (this.picksTracks() && (this.tracksLoading() || (this.selectedTracks().size === 0 && this.tracks().length > 0))) return false;
    return this.mode() === 'import' || this.audioQualityId() != null;
  });
  protected readonly titleKey = computed(() => {
    const r = this.req();
    if (!r) return 'discover.add_to_library';
    if (this.mode() === 'import') return 'discover.add_to_library';
    return this.hasSeasons() ? 'discover.request_series_title' : this.isVideo() ? 'discover.request_movie_title' : 'discover.request';
  });
  protected readonly confirmKey = computed(() =>
    this.mode() === 'import' ? 'discover.add_to_library' : this.hasSeasons() ? 'discover.select_seasons' : 'discover.request',
  );

  /** Adds the hit without a question when one library takes it, else opens the dialog. */
  async add(req: AddRequest): Promise<void> {
    const mode = req.mode ?? (this.auth.hasPermission('media.create') ? 'import' : 'request');
    this.begin(req, mode);
    if (!(await this.load(req))) {
      this.show();
      return;
    }
    if (askNothing(req, mode, this.choices())) {
      this.pick(this.libraries()[0] ?? null);
      await this.submit();
      return;
    }
    this.show();
  }

  private begin(req: AddRequest, mode: AddMode) {
    this.req.set(req);
    this.mode.set(mode);
    this.busy.set(false);
    this.loadFailed.set(false);
    this.seasons.set([]);
    this.selectedSeasons.set(new Set());
    this.seasonsFailed.set(false);
    this.tracksSeq++;
    this.tracks.set([]);
    this.selectedTracks.set(new Set());
    this.tracksLoading.set(false);
    this.tracksFailed.set(false);
    this.wants.set([{ family: 'text', language: null }]);
  }

  private show() {
    const r = this.req()!;
    this.dialogEl()?.nativeElement.showModal();
    if (this.hasSeasons()) this.loadSeasons(r);
    if (this.picksTracks()) void this.loadTracks(r);
  }

  /** Libraries and the profiles the kind needs; false when they did not load. */
  private async load(r: AddRequest): Promise<boolean> {
    this.loading.set(true);
    try {
      const video = r.kind === 'movie' || r.kind === 'series';
      const family = r.kind === 'book' ? 'text' : 'audio';
      const [libraries, quality, language, wantQuality] = await Promise.all([
        this.librariesApi.listMine(),
        video ? this.profilesApi.getQualityProfiles() : Promise.resolve([]),
        video ? this.profilesApi.getLanguageProfiles() : Promise.resolve([]),
        video ? Promise.resolve([]) : this.profilesApi.getQualityProfiles(family),
      ]);
      const pairs = (l: Profile[]) => l.map((p) => ({ id: p.id, name: p.name }));
      this.choices.set({ libraries, quality: pairs(quality), language: pairs(language), wantQuality: pairs(wantQuality) });
      if (r.kind === 'book') this.wants.set([{ family: 'text', language: null, qualityProfileId: wantQuality[0]?.id ?? null }]);
      this.pick(preselect(libraries, r.kind));
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
    const r = this.req();
    if (r && this.picksTracks()) void this.loadTracks(r);
  }

  /** The tracks of the release the library would target, all ticked. */
  private async loadTracks(r: AddRequest) {
    const library = this.libraryId();
    if (library == null) return;
    const seq = ++this.tracksSeq;
    this.tracks.set([]);
    this.selectedTracks.set(new Set());
    this.tracksLoading.set(true);
    this.tracksFailed.set(false);
    try {
      const seen = new Set<string>();
      const tracks = (await this.music.albumTracks(r.provider, r.externalId, library)).filter((t) => t.recordingId != null && !seen.has(t.recordingId) && seen.add(t.recordingId));
      if (seq !== this.tracksSeq) return;
      this.tracks.set(tracks);
      this.selectedTracks.set(new Set(tracks.map((t) => t.recordingId!)));
    } catch {
      if (seq === this.tracksSeq) this.tracksFailed.set(true);
    } finally {
      if (seq === this.tracksSeq) this.tracksLoading.set(false);
    }
  }

  protected toggleTrack(id: string) {
    this.selectedTracks.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected toggleAllTracks() {
    const all = this.tracks().map((t) => t.recordingId!);
    this.selectedTracks.set(this.selectedTracks().size === all.length ? new Set() : new Set(all));
  }

  /** Specials start unticked on an add, and nothing is ticked on a request unless the caller said so. */
  private loadSeasons(r: AddRequest) {
    this.seasonsLoading.set(true);
    const pre = new Set(r.preselectedSeasons ?? []);
    this.metadata
      .getSeasonStubs(r.provider, r.externalId)
      .then((stubs) => {
        this.seasons.set(stubs);
        const taken = this.alreadyRequested();
        const ticked =
          this.mode() === 'import'
            ? stubs.map((s) => s.seasonNumber).filter((n) => n > 0)
            : stubs.map((s) => s.seasonNumber).filter((n) => pre.has(n) && !taken.has(n));
        this.selectedSeasons.set(new Set(ticked));
      })
      .catch(() => this.seasonsFailed.set(true))
      .finally(() => this.seasonsLoading.set(false));
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

  protected close() {
    this.dialogEl()?.nativeElement.close();
  }

  protected async submit(): Promise<void> {
    const r = this.req();
    if (!r || !this.canSubmit()) return;
    this.busy.set(true);
    try {
      const mediaId = this.mode() === 'import' ? await this.importIt(r) : await this.requestIt(r);
      rememberLibrary(r.kind, this.libraryId());
      this.toast.success(this.translate.instant(this.mode() === 'import' ? 'discover.import_success' : 'discover.request_success'));
      this.close();
      this.done.emit({ mode: this.mode(), mediaId });
    } catch {
      // The global HTTP interceptor toasts the failure.
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

  private async importIt(r: AddRequest): Promise<number | null> {
    const place = this.place();
    switch (r.kind) {
      case 'book': {
        const saved = await this.books.import({ type: 'book', provider: r.provider, externalId: r.externalId, wants: this.readyWants(), ...place });
        return saved.id;
      }
      case 'album': {
        if (r.recording) {
          const w = await this.music.wantRecording({ provider: r.provider, externalId: r.recording.externalId, albumExternalId: r.externalId, wants: this.audioWants(), ...place });
          return w.mediaId;
        }
        const picked = this.selectedTracks().size < this.tracks().length ? [...this.selectedTracks()] : undefined;
        return (await this.music.importAlbum({ provider: r.provider, externalId: r.externalId, wants: this.audioWants(), monitoredRecordings: picked, ...place })).id;
      }
      default: {
        const saved = await this.metadata.importMedia({
          type: r.kind,
          provider: r.provider,
          externalId: r.externalId,
          qualityProfileId: this.qualityId()!,
          languageProfileId: this.languageId() ?? undefined,
          ...place,
          ...(this.hasSeasons() && !this.seasonsFailed() ? { monitoredSeasons: [...this.selectedSeasons()].sort((a, b) => a - b) } : {}),
        });
        return saved.id;
      }
    }
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

  private async requestIt(r: AddRequest): Promise<number | null> {
    const place = this.place();
    let body: CreateRequestBody;
    if (r.kind === 'book') {
      body = { mediaType: 'book', externalId: r.externalId, title: r.title, wants: this.readyWants(), ...place };
    } else if (r.kind === 'album') {
      body = { mediaType: 'album', externalId: r.externalId, title: r.title, wants: [{ family: 'audio', language: null, qualityProfileId: this.audioQualityId() }], ...place };
    } else {
      body = {
        mediaType: r.kind as 'movie' | 'series',
        ...(r.titleKey ?? (r.provider === 'tmdb' ? { tmdbId: Number(r.externalId) } : { provider: r.provider, externalId: r.externalId })),
        title: r.title,
        qualityProfileId: this.qualityId() ?? undefined,
        languageProfileId: this.languageId() ?? undefined,
        ...place,
        ...(this.hasSeasons() && this.selectedSeasons().size > 0 ? { seasons: [...this.selectedSeasons()].sort((a, b) => a - b) } : {}),
      };
    }
    const row = await this.requestsApi.create(body);
    return row.mediaId ?? null;
  }
}
