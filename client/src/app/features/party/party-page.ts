import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { PartyApiService, type PartyDto, type PartyItem, type PartyPreview, type PartySummaryDto } from '../../core/services/api/party-api.service';
import { MediaService, type Media } from '../../core/services/api/media.service';
import { addToCalendar } from '../../core/plugins/calendar.plugin';
import { buildPartyIcs, partyDurationMin } from './party-ics';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { ClockService } from '../../core/services/party/clock.service';
import { PartyService } from '../../core/services/party/party.service';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { formatTime } from '../../core/utils/player.utils';
import { groupPosition } from '../../core/services/party/party-drift';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { connectedCount, missingCount, partyPeople, type PartyPerson } from '../player/party/party-people';
import { runBusy } from './party-busy';
import { PartyHostDialogComponent } from './party-host-dialog';
import { PartyInviteComponent } from './party-invite';
import { PartyProposalsComponent, bestProposals, topProposal } from './party-proposals';
import { PartyProgrammeComponent, findEpisode, sameItem } from './party-programme';
import { PartyCoverComponent } from './party-cover';
import { PartyPersonRowComponent } from '../player/party/party-person-row';
import { PartyChatComponent } from '../player/party/party-chat';
import { PartyVoiceBarComponent } from '../player/party/party-voice-bar';
import { VoiceService } from '../../core/services/party/voice.service';
import { LucideCalendarPlus, LucideCheck, LucideCrown, LucideDices, LucideEllipsisVertical, LucidePlay, LucideSettings, LucideShare2, LucideUserMinus, LucideX } from '@lucide/angular';
import { DropdownMenuComponent } from '../../shared/components/dropdown-menu';
import { BackgroundService } from '../../core/services/background.service';
import { DeviceService } from '../../core/services/device.service';
import { NavbarService } from '../../core/services/navbar.service';
import { TvService } from '../../core/services/tv.service';
import { MD_BREAKPOINT_QUERY, mediaQuerySignal } from '../../core/utils/viewport';
import { MobileFanartHeroComponent } from '../../shared/components/mobile-fanart-hero';
import { SynopsisComponent } from '../../shared/components/synopsis/synopsis';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';
import { armPageSlide } from '../../shared/utils/page-slide';
import { episodeLabel } from '../../shared/utils/episode-label';
import { pickFanart } from '../../shared/utils/media-artwork.util';
import { partyWhen } from './party-time';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';

const JOIN_RETRY_MS = 10_000;

/** The server has no live stream for this device yet: the one join refusal worth retrying. */
const isNoConnection = (e: unknown) => e instanceof HttpErrorResponse && (e.error as { message?: unknown } | null)?.message === 'party.error_no_connection';

/** `/parties/:id`: a party's page. Scheduled: the lobby (members, chat, voice, ready, start); live: join. */
@Component({
  selector: 'app-party-page',
  imports: [
    NgTemplateOutlet, RouterLink, SynopsisComponent, TranslatePipe, TranslatePluralPipe, TvSectionDirective, TvRowDirective, DefaultFocusDirective, PartyHostDialogComponent, PartyInviteComponent, PartyProposalsComponent, PartyProgrammeComponent, PartyCoverComponent, PartyPersonRowComponent, PartyChatComponent, PartyVoiceBarComponent,
    MobileFanartHeroComponent, UserAvatarComponent,
    LucideCalendarPlus, LucideCheck, LucideCrown, LucideDices, LucideEllipsisVertical, LucidePlay, LucideSettings, LucideShare2, LucideUserMinus, LucideX, DropdownMenuComponent,
  ],
  templateUrl: './party-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(PartyApiService);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  protected readonly sse = inject(SseService);
  private readonly clock = inject(ClockService);
  private readonly mediaService = inject(MediaService);
  protected readonly party = inject(PartyService);
  private readonly voice = inject(VoiceService);
  protected readonly navbar = inject(NavbarService);
  protected readonly tv = inject(TvService);
  private readonly background = inject(BackgroundService);
  protected readonly device = inject(DeviceService);
  private readonly mdUp = mediaQuerySignal(MD_BREAKPOINT_QUERY);

  protected readonly hostDialog = viewChild(PartyHostDialogComponent);

  private readonly id = Number(this.route.snapshot.params['id']);
  private readonly token: string | undefined = this.route.snapshot.queryParams['token'];

  private readonly loaded = signal<PartyPreview | null>(null);
  protected readonly gone = signal(false);
  /** The server's clock, so a device that runs fast does not skew the countdown. */
  protected readonly now = signal(this.clock.serverNow());
  protected readonly busy = signal(false);
  private readonly joining = signal(false);
  private readonly quitting = signal(false);
  protected readonly desktopLayout = computed(() => this.device.isTv() || this.mdUp());
  /** Pairs the page's picture with the home card it opened from. */
  protected readonly posterName = `party-poster-${this.id}`;
  /** The card's summary, handed over router state so the hero is there when the transition captures. */
  private readonly seed = signal<PartySummaryDto | null>(this.handedParty());
  private readonly media = signal<Media | null>(null);

  /** The service copy while joined (it follows the events), else the page's own load. */
  protected readonly view = computed(() => (this.party.party()?.id === this.id ? this.party.party() : this.loaded()));
  protected readonly head = computed<PartySummaryDto | null>(() => this.view() ?? this.seed());
  private readonly fanart = computed(() => {
    const item = this.head()?.item;
    return item ? pickFanart({ ...item, id: item.mediaId }) : null;
  });
  protected readonly heroUrl = computed(() => this.fanart() ?? this.head()?.item?.posterUrl ?? null);
  private readonly episodeInfo = computed(() => findEpisode(this.media(), this.head()?.item?.episodeId));
  protected readonly overview = computed(() => {
    return this.episodeInfo()?.episode.overview || this.media()?.overview || '';
  });
  protected readonly mediaLink = computed<string[] | null>(() => {
    const item = this.head()?.item;
    const m = this.media();
    if (!item || !m) return null;
    const base = ['/' + (m.type === 'movie' ? 'movies' : 'series'), '' + item.mediaId];
    return item.episodeId == null ? base : [...base, 'episode', '' + item.episodeId];
  });
  protected readonly armSlide = armPageSlide;
  protected readonly episode = computed(() => {
    const found = this.episodeInfo();
    return found
      ? episodeLabel({ seasonNumber: found.season.seasonNumber, episodeNumber: found.episode.episodeNumber, episodeTitle: found.episode.title })
      : '';
  });
  /** This device is in the party's room, in the lobby or watching. */
  protected readonly inParty = computed(() => this.party.active() && this.party.party()?.id === this.id);
  protected readonly joined = computed(() => this.party.lobby() && this.party.party()?.id === this.id);
  /** The full snapshot, which a non-member's preview is not. */
  protected readonly hostView = computed<PartyDto | null>(() => {
    const v = this.view();
    return v && 'guests' in v ? (v as PartyDto) : null;
  });
  private readonly msLeft = computed(() => {
    const at = this.view()?.scheduledAt;
    return at ? Date.parse(at) - this.now() : null;
  });
  protected readonly countdown = computed(() => {
    const left = this.msLeft();
    return left != null && left > 0 ? formatTime(left / 1000) : null;
  });
  protected readonly when = computed(() => {
    const at = this.view()?.scheduledAt;
    return at ? partyWhen(at, this.translate, this.now()) : '';
  });
  /** From the handed summary as soon as there is one, so the badge never flips from lobby to live on arrival. */
  protected readonly phase = computed<'live' | 'lobby' | null>(() => {
    const status = this.head()?.status;
    return status == null ? null : status === 'live' ? 'live' : 'lobby';
  });
  protected readonly people = computed<PartyPerson[]>(() => {
    const v = this.view();
    const members = this.inParty() ? this.party.members() : (v?.live?.members ?? []);
    return v ? partyPeople(v.host, v.guests ?? [], members, this.voice.speaking()) : [];
  });
  /** Added by the host or joined with the link: free to quit the party for good. */
  protected readonly guest = computed(() => {
    const me = this.auth.user()?.id;
    return !!this.hostView()?.guests.some((g) => g.userId === me);
  });
  protected readonly connectedCount = computed(() => connectedCount(this.people()));
  protected readonly missingCount = computed(() => missingCount(this.people()));
  protected readonly canHost = computed(() =>
    this.joined() ? this.party.isHost() : this.view()?.host.userId === this.auth.user()?.id,
  );
  protected readonly link = computed(() => this.party.inviteLink(this.view()?.inviteToken ?? null));
  /** A film is chosen, or a proposal the host can open exists for the server to take the top vote from. */
  /** Proposals tied for first leave a start on the top vote nothing to play. */
  protected readonly voteTied = computed(() => !this.head()?.item && bestProposals(this.party.proposals()).length > 1);
  /** The programme as the programme section holds it. */
  protected readonly programme = signal<PartyItem[]>([]);
  protected readonly proposedItems = computed(() => this.party.proposals().map((p) => p.item));
  /** A proposal already accepted into the programme leaves the list until it is sent back. */
  protected readonly openProposals = computed(() => this.party.proposals().filter((p) => !this.programme().some((i) => sameItem(i, p.item))));
  protected readonly canStart = computed(() => !!this.head()?.item || !!topProposal(this.party.proposals()));
  /** The chat column exists in the lobby only; the live phase gives the page its full width. */
  protected readonly chatShown = computed(() => this.phase() === 'lobby' && this.joined());
  protected readonly ready = computed(() => this.party.me()?.status === 'ready');
  /** The action row has its final buttons: before the lobby join only Quit shows, and the default focus must wait for Ready/Start. */
  protected readonly actionsSettled = computed(() => this.phase() !== 'lobby' || this.joined());
  /** Where the group is in the playing item, from the last snapshot; refetched on every transition. */
  protected readonly progress = computed(() => {
    const p = this.view()?.live?.playback;
    if (!p || this.view()?.status !== 'live') return null;
    const at = groupPosition(p.state, p.anchor, this.now());
    const runtime = (this.episodeInfo()?.episode.runtime ?? this.media()?.runtime ?? 0) * 60;
    return { at: runtime ? Math.min(at, runtime) : at, runtime, paused: p.state !== 'playing' };
  });

  constructor() {
    // The page needs the clock offset before it has joined anything.
    this.clock.start();
    const tick = setInterval(() => this.now.set(this.clock.serverNow()), 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      if (!this.party.party()) this.clock.stop();
    });
    this.party.startSkipped.pipe(takeUntilDestroyed()).subscribe((dto) => dto.id === this.id && this.loaded.set(dto));
    this.sse.partyEvents.pipe(takeUntilDestroyed()).subscribe((e) => {
      // Joined, the service refetches on these and the page follows its copy.
      if ((e.type === 'party.updated' || e.type === 'party.settings') && e.partyId === this.id && !this.joined()) void this.load();
    });
    this.party.closed.pipe(takeUntilDestroyed()).subscribe(() => void this.router.navigateByUrl('/'));
    effect(() => {
      const h = this.gone() ? null : this.head();
      if (h) this.navbar.enterHeroPage(h.name, this.media()?.logoUrl ?? null);
      else this.navbar.leaveHeroPage();
    });
    effect(() => this.background.set(this, this.fanart()));
    // The film can change under the page (the host's pick, a snapshot): its details follow.
    effect(() => {
      const id = this.head()?.item?.mediaId ?? null;
      untracked(() => void this.loadMedia(id));
    });
    // The lobby is open from creation: the page joins it once the live stream is up.
    effect(() => {
      if (!this.sse.connected() || this.view()?.status !== 'scheduled' || this.joined() || this.joining() || this.quitting() || this.gone()) return;
      untracked(() => void this.joinLobby());
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.navbar.leaveHeroPage();
    this.background.release(this);
    if (this.party.lobby() && this.party.party()?.id === this.id) void this.party.leave();
  }

  private handedState(): { party?: PartySummaryDto } | null {
    return this.router.getCurrentNavigation()?.extras.state ?? history.state;
  }

  private handedParty(): PartySummaryDto | null {
    const handed = this.handedState()?.party;
    return handed?.id === this.id ? handed : null;
  }

  /** A member's own copy first (a regenerated token no longer resolves for them), the invite link's preview otherwise. */
  private fetch(): Promise<PartyPreview> {
    const token = this.token;
    // Quiet: a party out of reach (quit, ended, kicked) shows the gone page, not a toast.
    if (!token) return this.api.get(this.id, true);
    return this.api.get(this.id, true).catch(() => this.api.byToken(token));
  }

  private async load(): Promise<void> {
    try {
      const dto = await this.fetch();
      this.gone.set(dto.status === 'ended');
      this.loaded.set(dto);
    } catch {
      this.gone.set(true);
    }
  }

  private async loadMedia(id: number | null): Promise<void> {
    if (this.media()?.id === id) return;
    this.media.set(null);
    if (id == null) return;
    const m = await this.mediaService.getOne(id).catch(() => null);
    if (m && this.head()?.item?.mediaId === id) this.media.set(m);
  }

  private async joinLobby(): Promise<void> {
    this.joining.set(true);
    try {
      await this.party.enter(this.id, this.token, true);
    } catch (err) {
      // A refusal is final and shows the gone page once; only a missing stream is retried.
      if (isNoConnection(err)) setTimeout(() => this.joining.set(false), JOIN_RETRY_MS);
      else this.gone.set(true);
      return;
    }
    this.joining.set(false);
  }

  protected join(): void {
    void this.party.enter(this.id, this.token).catch(() => {});
  }

  protected copy(): void {
    void this.party.shareLink(this.link(), this.view()?.name ?? '');
  }

  protected async addToCalendar(): Promise<void> {
    const v = this.view();
    if (!v?.scheduledAt) return;
    const media = this.media() ?? (v.item ? await this.mediaService.getOne(v.item.mediaId).catch(() => null) : null);
    const episode = findEpisode(media, v.item?.episodeId)?.episode;
    const start = new Date(v.scheduledAt);
    const runtimeMin = episode?.runtime ?? media?.runtime;
    const url = this.link();
    try {
      await addToCalendar({
        id: v.id,
        title: v.name,
        start,
        end: new Date(start.getTime() + partyDurationMin(runtimeMin) * 60_000),
        url,
        ics: buildPartyIcs({ id: v.id, name: v.name, startsAt: start, runtimeMin, link: url }),
      });
    } catch {
      this.toast.error(this.translate.instant('party.error_generic'));
    }
  }

  protected toggleReady(): void {
    void this.party.setReady(!this.ready());
  }

  protected async start(): Promise<void> {
    const me = this.auth.user()?.id;
    const waiting = [...new Set(this.party.members().filter((m) => m.userId !== me && m.status === 'waiting').map((m) => m.username))];
    if (waiting.length) {
      const ok = await this.confirm.confirm({
        title: this.translate.instant('party.start_not_ready_title'),
        message: this.translate.instant('party.start_not_ready_message', { names: waiting.map((n) => `- ${n}`).join('\n') }),
        confirmLabel: this.translate.instant('party.start'),
      });
      if (!ok) return;
    }
    void this.party.start();
  }

  protected fmt(seconds: number): string {
    return formatTime(seconds);
  }

  /** On a tie for first, the host lets chance pick one of the tied proposals. */
  protected async drawLots(): Promise<void> {
    const tied = bestProposals(this.party.proposals());
    const pick = tied[Math.floor(Math.random() * tied.length)];
    if (!pick) return;
    const dto = await runBusy(this.busy, () => this.api.choose(this.id, pick.id));
    if (dto) this.apply(dto);
  }

  /** A member who closed the player leaves the room from here; the host ends it instead. */
  protected leaveRoom(): void {
    void this.party.leaveOrEnd();
  }

  protected async quit(): Promise<void> {
    this.quitting.set(true);
    const ok = await runBusy(this.busy, () => this.party.quit(this.id).then(() => true));
    if (ok) return this.home();
    this.quitting.set(false);
    this.toast.error(this.translate.instant('party.error_generic'));
  }

  protected apply(dto: PartyDto): void {
    this.loaded.set(dto);
    if (this.joined()) this.party.applySnapshot(dto);
  }

  protected async end(): Promise<void> {
    const h = this.head()!;
    const key = h.status === 'live' ? 'end' : 'cancel';
    const ok = await this.confirm.confirm({
      title: this.translate.instant(`party.${key}_title`),
      message: this.translate.instant(`party.${key}_message`, { name: h.name }),
      variant: 'danger',
    });
    if (!ok) return;
    // Joined, the service closes the party and its `closed` takes the page home.
    if (this.joined()) return void runBusy(this.busy, () => this.party.end());
    if ((await runBusy(this.busy, () => this.api.end(this.id))) === null) return;
    this.toast.info(this.translate.instant('party.closed_host_ended'));
    this.home();
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
  }
}
