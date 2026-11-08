import { Component, ElementRef, Injector, afterNextRender, forwardRef, OnDestroy, OnInit, Type, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgComponentOutlet } from '@angular/common';
import { TrackingModalService } from '../../core/services/tracking-modal.service';
import { MediaAdminService } from '../../core/services/media-admin.service';
import { IdentifyModalService } from '../../core/services/identify-modal.service';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { AuthService } from '../../core/services/auth.service';
import { ProfilesService, LanguageProfile } from '../../core/services/api/profiles.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { pickFanart } from '../../shared/utils/media-artwork.util';
import { MarkersApiService } from '../../core/services/api/markers-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { ReleasesModalComponent } from './components/releases-modal/releases-modal.component';
import { MediaDetailProfilesModalComponent } from './components/media-detail-profiles-modal/media-detail-profiles-modal.component';
import { MediaLibraryDialogComponent } from '../../shared/components/media-library-dialog/media-library-dialog';
import { RequestModalComponent } from '../tmdb-preview/components/request-modal/request-modal.component';
import { serverMessage } from '../../core/utils/server-message';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ToastService } from '../../core/services/toast.service';
import { SseService, type SseEvent } from '../../core/services/sse.service';
import { MediaType } from '../../core/enums/media-type.enum';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { keepRouteFresh } from '../../core/services/keep-route-fresh';
import { ModalHeaderComponent } from '../../shared/components/modal-header';
import { ModalFooterComponent } from '../../shared/components/modal-footer';
import { ReleaseGrabController } from './release-grab-controller';
import { WantsStore } from '../../core/acquisition/acquisition';
import { DETAIL_HERO_HOST } from '../../shared/components/detail-hero/detail-hero';
import { AnalyzeController } from './analyze-controller';
import { RequestFlowController } from './request-flow-controller';
import { mediaDetailLink, kindOf } from '../../core/media-kinds';
import { MEDIA_DETAIL_HOST, type HandedEpisode, type MediaDetailHost } from './media-detail-host';

/** The route shell of every detail page: loads the title, owns the hero chrome, the scroll memory and the modals
 *  every kind shares, and renders the kind's page (`data.page`) with the loaded media. */
@Component({
  selector: 'app-media-detail',
  imports: [
    ModalFooterComponent,
    ModalHeaderComponent,
    TranslatePipe,
    DefaultFocusDirective,
    ReleasesModalComponent,
    MediaDetailProfilesModalComponent,
    MediaLibraryDialogComponent,
    RequestModalComponent,
    NgComponentOutlet,
    TvSectionDirective,
  ],
  templateUrl: './media-detail.html',
  providers: [
    { provide: MEDIA_DETAIL_HOST, useExisting: forwardRef(() => MediaDetailComponent) },
    { provide: DETAIL_HERO_HOST, useExisting: forwardRef(() => MediaDetailComponent) },
    ReleaseGrabController,
  ],
})
export class MediaDetailComponent implements OnInit, OnDestroy, MediaDetailHost {
  constructor() {
    this.grabs.attach(
      () => this.media(),
      () => this.releasesModal(),
    );
    // A refreshed media is the moment a want may have become satisfied.
    effect(() => {
      const id = this.media()?.id;
      if (id != null) untracked(() => void this.wantsStore.load(id));
    });
  }

  private readonly identifyModalService = inject(IdentifyModalService);
  private readonly admin = inject(MediaAdminService);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mediaService = inject(MediaService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly navbarService = inject(NavbarService);
  private readonly backgroundService = inject(BackgroundService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly sse = inject(SseService);
  private readonly markersApi = inject(MarkersApiService);
  private readonly requestsApi = inject(RequestsService);

  readonly grabs = inject(ReleaseGrabController);
  private readonly wantsStore = inject(WantsStore);
  readonly analyze = new AnalyzeController(
    {
      media: () => this.media(),
      dialog: () => this.analyzeDialog()?.nativeElement,
      firstOption: () => this.firstAnalyzeOption()?.nativeElement,
    },
    { media: this.mediaService, markers: this.markersApi, toast: this.toast, translate: this.translate },
  );
  readonly requestFlow = new RequestFlowController(
    { media: () => this.media(), requestModal: () => this.requestModal() },
    {
      auth: this.auth,
      requests: this.requestsApi,
      confirmation: this.confirmation,
      toast: this.toast,
      translate: this.translate,
    },
  );

  /** Same SSE payload must run handlers once; `media` updates (e.g. after rescan) re-run this effect.
   *  Seeded from the service so a re-created instance doesn't replay an event from before it existed. */
  private lastHandledSseEvent: SseEvent | null = this.sse.lastEvent();

  /** Signal mirror of paramMap: the component is reused across episode URLs, so a snapshot misses changes. */
  private readonly routeParams = toSignal(this.route.paramMap);

  /** Skeleton shape (still vs poster) read off the URL, since the page's episode focus only settles after the season tree loads. */
  protected readonly skeletonEpisode = computed(
    () => !!this.routeParams()?.get('episodeId'),
  );

  private loadedId: number | null = null;

  /** Cached route: coming back from the player repaints the page as it was, so
   *  only what playback changed has to be re-read, plus a forced media refetch. */
  private readonly routeFresh = keepRouteFresh({
    refresh: () => this.refreshOnReturn(),
    scrollKey: () => this.scrollKey(),
    onDetach: () => this.releaseChrome(),
    onAttach: () => this.restoreChrome(),
  });

  /** Last fanart declared, so returning to a cached page can re-declare it. */
  private fanartUrl: string | null = null;
  private fanartIsCover = false;

  /** The hero navbar and the backdrop are global state, so a cached page hands
   *  them back on the way out and reclaims them on return. */
  private releaseChrome(): void {
    this.navbarService.leaveHeroPage();
    this.backgroundService.suspend(this);
  }

  private restoreChrome(): void {
    this.backgroundService.set(this, this.fanartUrl, { blur: this.fanartIsCover });
    const m = this.media();
    if (m) this.navbarService.enterHeroPage(this.navTitle() ?? m.title, m.logoUrl);
    else this.navbarService.enterHeroPage('');
  }

  /** Driven by the route param, not ngOnInit: switching episodes reuses this instance and must not refetch the held series. */
  private readonly routeMediaEffect = effect(() => {
    const params = this.routeParams();
    if (!params) return;
    const id = Number(params.get('id'));
    if (id === this.loadedId) {
      // Another episode of the same series: the page that flagged the last one missing is gone, a new one re-checks.
      untracked(() => this.notFound.set(false));
      this.trackScroll();
      return;
    }
    this.loadedId = id;
    void this.loadMedia(id);
  });

  /** Retarget scroll memory to the page the params describe and request its offset on return.
   *  Episode-to-episode never detaches the route, so this is the only pass that can retarget the key. */
  private trackScroll(): void {
    const key = this.scrollKey();
    this.scrollMemory.activate(key);
    if (untracked(() => this.navbarService.navigatedBack())) this.scrollMemory.restoreSticky(key);
  }

  /** The navbar title follows the page: the title's own unless the kind page names another (an episode). */
  private readonly navbarEffect = effect(() => {
    const m = this.media();
    const title = this.navTitle();
    const params = this.routeParams();
    if (!m || !params || m.id !== Number(params.get('id'))) return;
    // Seeded stub: no season tree yet, so the page has not resolved what its title is.
    if (kindOf(m.type).hasSeasons && !m.seasons) return;
    this.navbarService.enterHeroPage(title ?? m.title, m.logoUrl);
  });

  /** Fanart, never the episode still (TMDB stills cap at ~780×438 and look mushy fullscreen); the blurred cover when there is none. */
  private readonly backgroundEffect = effect(() => {
    const m = this.media();
    const fanart = m ? pickFanart(m) : null;
    if (!fanart && !this.fullLoaded()) return;
    this.fanartIsCover = !fanart;
    this.fanartUrl = fanart ?? m?.posterUrl ?? null;
    this.backgroundService.set(this, this.fanartUrl, { blur: this.fanartIsCover });
  });

  /** React to SSE rescan / import / metadata-refresh events for this media */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    const m = this.media();
    if (!event || !m) return;
    if ((event['mediaId'] as number) !== m.id) return;
    if (event === this.lastHandledSseEvent) return;
    this.lastHandledSseEvent = event;
    if (
      event.type === 'rescan.completed' ||
      event.type === 'import.complete' ||
      event.type === 'media.move.completed'
    ) {
      void this.reload();
    } else if (event.type === 'metadata.refreshed') {
      void this.reload();
      this.toast.success(this.translate.instant('media_detail.refresh_ok'));
    } else if (event.type === 'metadata.failed') {
      this.toast.error(
        (event as { error?: string }).error ?? this.translate.instant('media_detail.refresh_error'),
      );
    }
  });

  readonly media = signal<Media | null>(null);
  /** The page of the kind, loaded by the route's resolver before this component activates. */
  protected readonly kindPage: Type<unknown> | null = this.route.snapshot.data['page'] ?? null;
  readonly returns = signal(0);
  readonly navTitle = signal<string | null>(null);
  private pageActions: Record<string, () => void> = {};

  readonly loading = signal(true);
  /** False while only a list handover is shown: it carries no `fanartUrl`, so its cover must not stand in for fanart yet. */
  readonly fullLoaded = signal(false);
  readonly notFound = signal(false);
  /** Card-known episode data painted into the header while the media request is in flight, so the poster morph has a target. */
  readonly episodeSeed = signal<HandedEpisode | null>(this.handedEpisode());

  readonly qualityProfileOptions = signal<{ id: number; name: string }[]>([]);
  readonly languageProfiles = signal<LanguageProfile[]>([]);
  readonly languageProfileOptions = signal<{ id: number; name: string }[]>([]);
  readonly profilesOptionsLoading = signal(false);
  readonly draftQualityProfileId = signal<number | null>(null);
  readonly draftLanguageProfileId = signal<number | null>(null);
  readonly profilesSaveLoading = signal(false);
  readonly profilesOk = signal('');
  readonly profilesErr = signal('');

  readonly libraries = signal<LibrarySummary[]>([]);

  readonly canGrab = computed(() => this.auth.hasPermission('media.grab'));

  readonly deleteLoading = signal(false);
  readonly monitoredLoading = signal(false);

  readonly releasesModal = viewChild<ReleasesModalComponent>('releasesModal');
  readonly profilesModal = viewChild(MediaDetailProfilesModalComponent);
  readonly libraryDialog = viewChild(MediaLibraryDialogComponent);

  private readonly scrollMemory = inject(ScrollMemoryService);

  /** Own memory per media and per episode, so back from an episode lands where
   *  it left rather than on the other page's offset. */
  private scrollKey(): string {
    const ep = this.route.snapshot.paramMap.get('episodeId');
    return ep ? `episode-${ep}` : `media-${this.route.snapshot.paramMap.get('id')}`;
  }

  ngOnDestroy() {
    this.backgroundService.release(this);
    // Evicted from the route cache while another page is on screen: the chrome
    // and scroll key already belong to that page, so leave them alone.
    if (this.routeFresh()) return;
    this.scrollMemory.deactivateIf(this.scrollKey());
    this.releaseChrome();
  }

  ngOnInit() {
    // Enter hero page immediately (transparent navbar) - title will be set after media loads
    this.navbarService.enterHeroPage('');
    // Load profiles in parallel with media - neither blocks the other
    void this.loadProfiles();
  }

  private async loadProfiles() {
    // Either permission needs the profile options (admins edit inline, requesters fill the request modal).
    if (!this.auth.hasPermission('media.edit') && !this.auth.hasPermission('requests.create'))
      return;
    this.profilesOptionsLoading.set(true);
    try {
      const [q, l, libs] = await Promise.all([
        this.profilesApi.getQualityProfiles(),
        this.profilesApi.getLanguageProfiles(),
        this.librariesApi.listMine(),
      ]);
      this.qualityProfileOptions.set(q.map((p) => ({ id: p.id, name: p.name })));
      this.languageProfiles.set(l);
      this.languageProfileOptions.set(l.map((p) => ({ id: p.id, name: p.name })));
      this.libraries.set(libs);
    } catch {
      // Profiles will just be empty - the page still works
    } finally {
      this.profilesOptionsLoading.set(false);
    }
  }

  /** Paint the episode header from the card handoff: a stub series replaced wholesale when real media lands.
   *  The stub has no `seasons`, which tells the series page to leave the seed alone. */
  private seedFromHandedEpisode(mediaId: number): boolean {
    const seed = this.handedEpisode();
    this.episodeSeed.set(seed);
    if (!seed) return false;
    this.media.set({
      id: mediaId,
      type: 'series',
      title: seed.title ?? '',
      monitored: true,
    } as unknown as Media);
    return true;
  }

  private handedEpisode(): HandedEpisode | null {
    const handed = (history.state as { episode?: HandedEpisode & { id: number } })?.episode;
    const param = Number(this.route.snapshot.paramMap.get('episodeId'));
    if (!handed?.stillUrl || handed.id !== param) return null;
    return {
      episodeId: param,
      stillUrl: handed.stillUrl,
      title: handed.title ?? null,
      label: handed.label ?? null,
    };
  }

  private async loadMedia(id: number) {
    const kind = this.route.snapshot.data['kind'] as MediaType;
    // Only back navigation restores the offset; other opens start at the top.
    // Android's back gesture is an imperative `goBack()`, so the router trigger can't be used.
    const wentBack = untracked(() => this.navbarService.navigatedBack());
    this.scrollMemory.activate(this.scrollKey());
    if (!Number.isFinite(id) || id < 1) {
      this.loading.set(false);
      this.notFound.set(true);
      return;
    }

    // Nothing here survives a switch to another title.
    this.notFound.set(false);
    this.fullLoaded.set(false);
    this.navTitle.set(null);

    // Card handoff via router state renders immediately; the fetch below still brings cast/crew/files/seasons.
    const passed = (history.state as { media?: Media })?.media;
    if (passed && passed.id === id && passed.type === kind) {
      this.media.set(passed);
      this.loading.set(false);
    } else if (this.seedFromHandedEpisode(id)) {
      this.loading.set(false);
    } else if (this.media()?.id !== id) {
      this.media.set(null);
      this.loading.set(true);
    }

    try {
      const m = await this.mediaService.getOne(id);
      if (this.loadedId !== id) return;
      if (m.type !== kind) {
        void this.router.navigate(mediaDetailLink(m.type, m.id));
        return;
      }
      this.media.set(m);
      this.fullLoaded.set(true);
      // Paint from the cache-served media immediately; the uncacheable
      // playback-state calls the page makes must not gate first paint.
      this.loading.set(false);
      this.openFromQueryParam();
      // Router scroll restoration is 'top', so restore by hand and sticky: late-landing content clamps a one-off scrollTo.
      if (wentBack) this.scrollMemory.restoreSticky(this.scrollKey());
      this.draftQualityProfileId.set(m.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(m.languageProfile?.id ?? null);
      queueMicrotask(() => {
        void this.mediaService
          .getOne(id, { force: true })
          .then((fresh) => {
            if (fresh.type === kind && this.loadedId === id) this.media.set(fresh);
          })
          .catch(() => {
            /* network failure - cached body keeps showing */
          });
      });

      this.requestFlow.load(m);
    } catch {
      if (this.loadedId === id) this.notFound.set(true);
    } finally {
      if (this.loadedId === id) this.loading.set(false);
    }
  }

  /** Tells the page to re-read what playback changed, and forces a media refetch. */
  private refreshOnReturn(): void {
    const m = this.media();
    if (!m) return;
    this.returns.update((n) => n + 1);
    void this.mediaService
      .getOne(m.id, { force: true })
      .then((fresh) => {
        if (this.loadedId === m.id) this.media.set(fresh);
      })
      .catch(() => {
        /* network failure - the cached page keeps showing */
      });
  }

  onLibrarySaved(updated: Media) {
    this.media.set(updated);
  }

  async saveProfiles() {
    const m = this.media();
    if (!m) return;
    this.profilesSaveLoading.set(true);
    this.profilesOk.set('');
    this.profilesErr.set('');
    try {
      const updated = await this.mediaService.patchProfiles(m.id, {
        qualityProfileId: this.draftQualityProfileId(),
        languageProfileId: this.draftLanguageProfileId(),
      });
      this.media.set(updated);
      this.draftQualityProfileId.set(updated.qualityProfile?.id ?? null);
      this.draftLanguageProfileId.set(updated.languageProfile?.id ?? null);
      this.profilesOk.set(this.translate.instant('media_detail.profiles_saved'));
    } catch (err: unknown) {
      this.profilesErr.set(serverMessage(err, this.translate, 'media_detail.profiles_save_error'));
    } finally {
      this.profilesSaveLoading.set(false);
    }
  }

  async toggleMonitored() {
    const m = this.media();
    if (!m) return;
    this.monitoredLoading.set(true);
    try {
      this.media.set(await this.mediaService.toggleMonitored(m.id, !m.monitored));
    } finally {
      this.monitoredLoading.set(false);
    }
  }

  async deleteMedia() {
    const m = this.media();
    if (!m || !(await this.admin.confirmDelete(m))) return;
    this.deleteLoading.set(true);
    try {
      await this.admin.removeMedia(m);
    } finally {
      this.deleteLoading.set(false);
    }
  }

  registerPageActions(actions: Record<string, () => void>) {
    this.pageActions = actions;
  }

  openProfiles() {
    this.profilesOk.set('');
    this.profilesErr.set('');
    this.profilesModal()?.showModal();
  }

  openLibrary() {
    this.libraryDialog()?.open();
  }

  openAnalyze() {
    this.analyze.open();
  }

  async refreshMetadata() {
    const m = this.media();
    if (m) await this.admin.refreshMetadata(m.id);
  }

  /** Native <dialog>: showModal() gives focus trap, Tab cycling and Escape for free. */
  private readonly analyzeDialog = viewChild<ElementRef<HTMLDialogElement>>('analyzeDialog');
  private readonly firstAnalyzeOption =
    viewChild<ElementRef<HTMLInputElement>>('firstAnalyzeOption');

  /** Opens a modal from `?action=` so a media card can reach it without hoisting modals to the layout.
   *  The param is stripped once consumed so a reload doesn't reopen it. */
  private openFromQueryParam() {
    const action = this.route.snapshot.queryParamMap.get('action');
    if (!action) return;
    const m = this.media();
    if (!m) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { action: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    // After the render that creates the page, so the actions it registers count.
    afterNextRender(() => {
      const openers: Record<string, () => void> = {
        identify: () => this.openIdentify(),
        library: () => this.openLibrary(),
        analyze: () => this.openAnalyze(),
        refresh: () => void this.refreshMetadata(),
        tracking: () => this.trackingModals.open(m.id, { kind: m.type }),
        // Profiles are a video title's; a book's are its wants, inside its own page.
        ...(kindOf(m.type).families.includes('video') && { profiles: () => this.openProfiles() }),
        ...this.pageActions,
      };
      openers[action]?.();
    }, { injector: this.injector });
  }

  openIdentify() {
    const m = this.media();
    if (m) this.admin.identify(m);
  }

  /** The title, art and whole episode tree change, so the page reloads rather
   *  than patching the row - same path the rescan takes. */
  /** Dialog reports via a counter; the first read is ignored since an effect fires on creation. */
  private seenIdentified = -1;
  private readonly identifiedEffect = effect(() => {
    const n = this.identifyModalService.identified();
    if (this.seenIdentified < 0) {
      this.seenIdentified = n;
      return;
    }
    if (n === this.seenIdentified) return;
    this.seenIdentified = n;
    this.onIdentified();
  });

  onIdentified() {
    void this.reload();
  }

  /** Re-read media after an external change; forced because server events invalidate no cache entry. */
  async reload() {
    const id = this.media()?.id;
    if (id == null) return;
    try {
      const fresh = await this.mediaService.getOne(id, { force: true });
      if (this.loadedId === id) this.media.set(fresh);
    } catch {
      /* ignore */
    }
  }

  private readonly trackingModals = inject(TrackingModalService);
  private readonly requestModal = viewChild<RequestModalComponent>('requestModal');
}
