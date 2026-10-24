import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NgTemplateOutlet } from '@angular/common';
import { PartyApiService, type PartyDto, type PartyMemberStatus, type PartySummaryDto, type PartySwitches } from '../../core/services/api/party-api.service';
import { MediaService, type Media } from '../../core/services/api/media.service';
import { saveFile } from '../../core/plugins/save-file.plugin';
import { buildPartyIcs } from './party-ics';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { PartyService } from '../../core/services/party/party.service';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { formatTime } from '../../core/utils/player.utils';
import { TvRowDirective } from '../../shared/directives/tv-row.directive';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { PartyChatComponent } from '../player/party/party-chat';
import { PartyHostSwitchesComponent } from '../player/party/party-host-switches';
import { PartyVoiceBarComponent } from '../player/party/party-voice-bar';
import { VoiceService } from '../../core/services/party/voice.service';
import { LucideCalendarPlus, LucideCheck, LucideMic, LucideMicOff, LucidePlay, LucideShare2 } from '@lucide/angular';
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
import { PartyInviteePickerComponent } from './party-invitee-picker';
import { toLocalInput } from './party-create-modal';
import { partyWhen } from './party-time';
import { TranslatePluralPipe } from '../../core/pipes/translate-plural.pipe';
import { ResolveUrlPipe } from '../../core/pipes/resolve-url.pipe';

/** The lobby opens this long before the scheduled time (server `LOBBY_OPEN_BEFORE_MS`). */
const LOBBY_OPEN_MS = 15 * 60_000;

/** A person of the party: a live member, an invitee not here yet, or someone who came through the link. */
export interface PartyPerson {
  userId: number;
  username: string;
  host: boolean;
  state: 'connected' | 'invited' | 'link' | 'absent';
  status: PartyMemberStatus | null;
  voice: { muted: boolean } | null;
  speaking: boolean;
}

const STATE_RANK = { connected: 0, link: 1, invited: 2, absent: 3 } as const;

/** `/parties/:id`: a party's page. Scheduled: info, link and host actions; lobby open: members, ready, chat and start; live: join. */
@Component({
  selector: 'app-party-page',
  imports: [
    FormsModule, NgTemplateOutlet, RouterLink, SynopsisComponent, TranslatePipe, ResolveUrlPipe, TranslatePluralPipe, TvSectionDirective, TvRowDirective, PartyChatComponent, PartyHostSwitchesComponent, PartyInviteePickerComponent,
    PartyVoiceBarComponent, MobileFanartHeroComponent, UserAvatarComponent,
    LucideCalendarPlus, LucideCheck, LucideMic, LucideMicOff, LucidePlay, LucideShare2,
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
  private readonly sse = inject(SseService);
  private readonly mediaService = inject(MediaService);
  protected readonly party = inject(PartyService);
  protected readonly voice = inject(VoiceService);
  protected readonly navbar = inject(NavbarService);
  protected readonly tv = inject(TvService);
  private readonly background = inject(BackgroundService);
  private readonly device = inject(DeviceService);
  private readonly mdUp = mediaQuerySignal(MD_BREAKPOINT_QUERY);

  private readonly id = Number(this.route.snapshot.params['id']);
  private readonly token: string | undefined = this.route.snapshot.queryParams['token'];

  private readonly loaded = signal<PartyDto | null>(null);
  protected readonly gone = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly rescheduling = signal(false);
  protected readonly newWhen = signal('');
  protected readonly inviting = signal(false);
  protected readonly newInvitees = signal<number[]>([]);
  protected readonly busy = signal(false);
  private joining = false;
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
  protected readonly heroUrl = computed(() => this.fanart() ?? this.head()?.item.posterUrl ?? null);
  protected readonly overview = computed(() => {
    const m = this.media();
    const id = this.head()?.item.episodeId;
    const ep = id == null ? null : m?.seasons?.flatMap((s) => s.episodes ?? []).find((e) => e.id === id);
    return ep?.overview || m?.overview || '';
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
    const id = this.head()?.item.episodeId;
    if (id == null) return '';
    for (const s of this.media()?.seasons ?? []) {
      const e = s.episodes?.find((x) => x.id === id);
      if (e) return episodeLabel({ seasonNumber: s.seasonNumber, episodeNumber: e.episodeNumber, episodeTitle: e.title });
    }
    return '';
  });
  protected readonly joined = computed(() => this.party.lobby() && this.party.party()?.id === this.id);
  private readonly msLeft = computed(() => {
    const at = this.view()?.scheduledAt;
    return at ? Date.parse(at) - this.now() : null;
  });
  protected readonly lobbyOpen = computed(() => {
    const v = this.view();
    return v?.status === 'scheduled' && (v.live !== null || (this.msLeft() ?? Infinity) <= LOBBY_OPEN_MS);
  });
  protected readonly countdown = computed(() => {
    const left = this.msLeft();
    return left != null && left > 0 ? formatTime(left / 1000) : null;
  });
  protected readonly when = computed(() => {
    const at = this.view()?.scheduledAt;
    return at ? partyWhen(at, this.translate, this.now()) : '';
  });
  protected readonly phase = computed<'live' | 'lobby' | 'scheduled'>(() =>
    this.view()?.status === 'live' ? 'live' : this.lobbyOpen() ? 'lobby' : 'scheduled',
  );
  protected readonly people = computed<PartyPerson[]>(() => {
    const v = this.view();
    if (!v) return [];
    const speaking = this.voice.speaking();
    const byUser = new Map<number, PartyPerson>();
    for (const m of v.live?.members ?? []) {
      const known = byUser.get(m.userId);
      if (known) {
        known.voice ??= m.voice;
        known.speaking ||= speaking.has(m.deviceId);
        if (known.status === 'ready' && m.status !== 'ready') known.status = m.status;
        continue;
      }
      const invited = v.invitees.some((i) => i.userId === m.userId);
      byUser.set(m.userId, {
        userId: m.userId, username: m.username, host: m.role === 'host' || m.userId === v.host.userId,
        state: invited || m.userId === v.host.userId ? 'connected' : 'link',
        status: m.status, voice: m.voice, speaking: speaking.has(m.deviceId),
      });
    }
    const absent = (u: { userId: number; username: string }, host: boolean, state: PartyPerson['state']): PartyPerson => ({
      userId: u.userId, username: u.username, host, state, status: null, voice: null, speaking: false,
    });
    if (!byUser.has(v.host.userId)) byUser.set(v.host.userId, absent(v.host, true, 'absent'));
    for (const i of v.invitees) if (!byUser.has(i.userId)) byUser.set(i.userId, absent(i, false, 'invited'));
    return [...byUser.values()].sort((a, b) => Number(b.host) - Number(a.host) || STATE_RANK[a.state] - STATE_RANK[b.state]);
  });
  protected readonly connectedCount = computed(() => this.people().filter((p) => p.state === 'connected' || p.state === 'link').length);
  protected readonly voiceCount = computed(() => (this.view()?.live?.members ?? []).filter((m) => m.voice).length);
  protected readonly canHost = computed(() =>
    this.joined() ? this.party.isHost() : this.view()?.host.userId === this.auth.user()?.id,
  );
  protected readonly link = computed(() => this.party.inviteLink(this.view()?.inviteToken ?? null));
  protected readonly excluded = computed(() => [this.view()?.host.userId ?? 0, ...(this.view()?.invitees.map((i) => i.userId) ?? [])]);
  protected readonly ready = computed(() => this.party.me()?.status === 'ready');

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    this.sse.partyEvents.pipe(takeUntilDestroyed()).subscribe((e) => {
      if ((e.type === 'party.updated' || e.type === 'party.settings') && e.partyId === this.id) void this.load();
    });
    this.party.closed.pipe(takeUntilDestroyed()).subscribe(() => void this.router.navigateByUrl('/'));
    effect(() => {
      const h = this.gone() ? null : this.head();
      if (h) this.navbar.enterHeroPage(h.name);
      else this.navbar.leaveHeroPage();
    });
    effect(() => this.background.set(this, this.fanart()));
    // The lobby opens by itself while the page is on screen.
    effect(() => {
      if (!this.lobbyOpen() || this.joined() || this.joining) return;
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

  private async load(): Promise<void> {
    try {
      const dto = await (this.token ? this.api.byToken(this.token) : this.api.get(this.id));
      this.gone.set(dto.status === 'ended');
      this.loaded.set(dto);
      if (!this.media()) void this.mediaService.getOne(dto.item.mediaId).then((m) => this.media.set(m), () => undefined);
    } catch {
      this.gone.set(true);
    }
  }

  private async joinLobby(): Promise<void> {
    this.joining = true;
    try {
      await this.party.enter(this.id, this.token);
    } catch {
      /* not open yet or no access: the interceptor toasted it, the page stays informative */
    } finally {
      // No retry loop on a refusal; the next lobby change (reload) may try again.
      setTimeout(() => (this.joining = false), 10_000);
    }
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
    const media = this.media() ?? (await this.mediaService.getOne(v.item.mediaId).catch(() => null));
    const episode = media?.seasons?.flatMap((s) => s.episodes).find((e) => e.id === v.item.episodeId);
    const ics = buildPartyIcs({
      id: v.id,
      name: v.name,
      startsAt: new Date(v.scheduledAt),
      runtimeMin: episode?.runtime ?? media?.runtime,
      link: this.link(),
    });
    try {
      await saveFile(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), `party-${v.id}.ics`);
    } catch {
      this.toast.error(this.translate.instant('party.error_generic'));
    }
  }

  protected toggleReady(): void {
    void this.party.setReady(!this.ready());
  }

  protected start(): void {
    void this.party.start();
  }

  private apply(dto: PartyDto): void {
    this.loaded.set(dto);
    if (this.joined()) this.party.applySnapshot(dto);
  }

  private async run<T>(action: () => Promise<T>): Promise<T | null> {
    this.busy.set(true);
    try {
      return await action();
    } catch {
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  protected openReschedule(): void {
    const at = this.view()?.scheduledAt;
    this.newWhen.set(toLocalInput(at ? new Date(at) : new Date()));
    this.rescheduling.set(true);
  }

  protected async reschedule(): Promise<void> {
    if (!this.newWhen()) return;
    const at = new Date(this.newWhen());
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.reschedule_title'),
      message: this.translate.instant('party.reschedule_message', {
        name: this.view()?.name,
        when: partyWhen(at.toISOString(), this.translate, this.now()),
      }),
      confirmLabel: this.translate.instant('party.reschedule'),
    });
    if (!ok) return;
    const dto = await this.run(() => this.api.update(this.id, { scheduledAt: at.toISOString() }));
    if (dto) {
      this.apply(dto);
      this.rescheduling.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.cancel_title'),
      message: this.translate.instant('party.cancel_message', { name: this.view()?.name }),
      variant: 'danger',
    });
    if (!ok || (await this.run(() => this.api.end(this.id))) === null) return;
    this.toast.info(this.translate.instant('party.closed_host_ended'));
    void this.router.navigateByUrl('/');
  }

  protected async updateSettings(patch: Partial<PartySwitches>): Promise<void> {
    if (this.joined()) return this.party.updateSettings(patch);
    const dto = await this.run(() => this.api.update(this.id, patch));
    if (dto) this.apply(dto);
  }

  /** Host: takes a scheduled party live now, then joins it like everyone else. */
  protected async startNow(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.start_now_title'),
      message: this.translate.instant('party.start_now_message'),
      confirmLabel: this.translate.instant('party.start_now'),
    });
    if (!ok || !(await this.run(() => this.api.start(this.id)))) return;
    await this.party.enter(this.id);
  }

  protected async regenerate(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('party.regenerate_title'),
      message: this.translate.instant('party.regenerate_message'),
      confirmLabel: this.translate.instant('party.regenerate_link'),
      variant: 'warning',
    });
    if (!ok) return;
    const dto = await this.run(() => this.api.update(this.id, { regenerateToken: true }));
    if (dto) this.apply(dto);
  }

  protected async invite(): Promise<void> {
    const ids = this.newInvitees();
    if (!ids.length) return;
    const dto = await this.run(() => this.api.invite(this.id, ids));
    if (!dto) return;
    this.apply(dto);
    this.newInvitees.set([]);
    this.inviting.set(false);
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
  }
}
