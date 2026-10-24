import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PartyApiService, type PartyDto } from '../../core/services/api/party-api.service';
import { MediaService } from '../../core/services/api/media.service';
import { saveFile } from '../../core/plugins/save-file.plugin';
import { buildPartyIcs } from './party-ics';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { PartyService } from '../../core/services/party/party.service';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { formatTime } from '../../core/utils/player.utils';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { PartyChatComponent } from '../player/party/party-chat';
import { PartyVoiceBarComponent } from '../player/party/party-voice-bar';
import { VoiceService } from '../../core/services/party/voice.service';
import { LucideMic, LucideMicOff } from '@lucide/angular';
import { PartyInviteePickerComponent } from './party-invitee-picker';
import { toLocalInput } from './party-create-modal';
import { partyWhen } from './party-time';

/** The lobby opens this long before the scheduled time (server `LOBBY_OPEN_BEFORE_MS`). */
const LOBBY_OPEN_MS = 15 * 60_000;

/** `/parties/:id`: a party's page. Scheduled: info, link and host actions; lobby open: members, ready, chat and start; live: join. */
@Component({
  selector: 'app-party-page',
  imports: [FormsModule, TranslatePipe, TvSectionDirective, PartyChatComponent, PartyInviteePickerComponent, PartyVoiceBarComponent, LucideMic, LucideMicOff],
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

  /** The service copy while joined (it follows the events), else the page's own load. */
  protected readonly view = computed(() => (this.party.party()?.id === this.id ? this.party.party() : this.loaded()));
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
      if (e.type === 'party.updated' && e.partyId === this.id) void this.load();
    });
    this.party.closed.pipe(takeUntilDestroyed()).subscribe(() => void this.router.navigateByUrl('/'));
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
    if (this.party.lobby() && this.party.party()?.id === this.id) void this.party.leave();
  }

  private async load(): Promise<void> {
    try {
      const dto = await (this.token ? this.api.byToken(this.token) : this.api.get(this.id));
      this.gone.set(dto.status === 'ended');
      this.loaded.set(dto);
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
    const media = await this.mediaService.getOne(v.item.mediaId).catch(() => null);
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
    const dto = await this.run(() => this.api.update(this.id, { scheduledAt: new Date(this.newWhen()).toISOString() }));
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

  protected async regenerate(): Promise<void> {
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
