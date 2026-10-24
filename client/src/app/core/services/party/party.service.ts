import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import {
  PartyApiService,
  type CreatePartyBody,
  type PartyAnchor,
  type PartyDto,
  type PartyIntentAction,
  type PartyItem,
  type PartyMember,
  type PartyMessage,
  type PartyPlayState,
  type PartyPolicy,
  type PartyUser,
} from '../api/party-api.service';
import { MediaService } from '../api/media.service';
import { AuthService } from '../auth.service';
import { DeviceService } from '../device.service';
import { SseService, type PartyEvent } from '../sse.service';
import { ToastService } from '../toast.service';
import { translatedServerMessage } from '../../utils/server-message';
import { resolvePlayableFile } from '../../../shared/utils/media-play.util';
import { ServerConfigService } from '../server-config.service';
import { ClockService } from './clock.service';
import { ReactionCatalogService } from './reaction-catalog.service';

/** What the engine has to follow: the last applied `party.state` (or the snapshot's equivalent). */
export interface PartyLiveState {
  rev: number;
  state: PartyPlayState;
  item: PartyItem;
  anchor: PartyAnchor;
  whenMs: number | null;
  by: PartyUser | null;
  action: string | null;
}

export interface FloatingReaction {
  key: number;
  emoji: string;
  username: string;
  /** Horizontal start, percent of the video width. */
  left: number;
}

/** What the create dialog needs to know about the item to watch. */
export interface PartyCreateTarget {
  title: string;
  mediaId: number;
  mediaFileId: number;
  episodeId?: number;
}

const BUBBLE_MS = 4000;
const REACTION_MS = 3000;
const MAX_MESSAGES = 200;

/** Party-wide state: usable outside the player (invites, join links), the player's PartyController drives the engine from it. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // storage unavailable: the choice lasts for this session
  }
}

@Injectable({ providedIn: 'root' })
export class PartyService {
  private readonly api = inject(PartyApiService);
  private readonly sse = inject(SseService);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly reactionCatalog = inject(ReactionCatalogService);
  private readonly clock = inject(ClockService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly mediaService = inject(MediaService);
  private readonly device = inject(DeviceService);

  readonly party = signal<PartyDto | null>(null);
  readonly live = signal<PartyLiveState | null>(null);
  readonly members = signal<PartyMember[]>([]);
  readonly messages = signal<PartyMessage[]>([]);
  readonly unread = signal(0);
  readonly panelOpen = signal(false);
  /** Reaction settings, per device: the floating button over the video, and whether its row stays open. */
  readonly reactionDock = signal(readFlag('party.reactionDock', true));
  readonly reactionKeepOpen = signal(readFlag('party.reactionKeepOpen', false));
  readonly bubbles = signal<PartyMessage[]>([]);
  readonly reactions = signal<FloatingReaction[]>([]);
  /** The party ended under us (host ended, expired, kicked): the player leaves. */
  readonly closed = new Subject<'host_ended' | 'expired' | 'kicked'>();

  /** Set to open the create dialog mounted in the layout. */
  readonly createRequest = signal<PartyCreateTarget | null>(null);
  /** Joined to the lobby of a scheduled party (no player yet). */
  readonly lobby = computed(() => this.party()?.status === 'scheduled' && this.live() !== null);

  readonly active = computed(() => this.party() !== null && this.live() !== null);
  readonly item = computed(() => this.live()?.item ?? this.party()?.item ?? null);
  readonly policy = computed(() => this.party()?.policy ?? 'everyone');
  readonly me = computed(() => {
    const id = this.sse.targetId();
    return this.members().find((m) => m.userId === this.auth.user()?.id && m.deviceId === id) ?? null;
  });
  readonly isHost = computed(() => this.me()?.role === 'host');
  readonly canControl = computed(() => this.isHost() || this.policy() === 'everyone');

  /** Panel placement: beside the video, under it (phone portrait), over it (phone landscape) or the TV column. */
  readonly portrait = signal(true);
  readonly dock = computed<'right' | 'bottom' | 'drawer' | 'tv'>(() => {
    if (this.device.isTv()) return 'tv';
    if (this.device.isPhone()) return this.portrait() ? 'bottom' : 'drawer';
    return 'right';
  });

  private lastRev = 0;
  private nextKey = 0;
  private wasConnected = false;

  constructor() {
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(orientation: portrait)');
      this.portrait.set(mq.matches);
      mq.addEventListener('change', (e) => this.portrait.set(e.matches));
    }
    this.sse.partyEvents.subscribe((e) => this.onEvent(e));
    // The stream dropped: the server marked us away, so a fresh join rebinds the connection and returns the snapshot.
    effect(() => {
      const connected = this.sse.connected();
      untracked(() => {
        if (connected && !this.wasConnected && this.party()) void this.rejoin();
        this.wasConnected = connected;
      });
    });
  }

  private deviceId(): string {
    const id = this.sse.targetId();
    if (!id) throw new Error('party: no SSE device id');
    return id;
  }

  // ── Entry points ──

  /** Immediate parties open the player; a scheduled one is announced with its link. */
  async create(body: CreatePartyBody): Promise<void> {
    const dto = await this.api.create(body);
    if (dto.status === 'live') {
      await this.enter(dto.id);
      return;
    }
    const link = this.inviteLink(dto.inviteToken);
    this.toast.success(
      this.translate.instant('party.toast_scheduled', { name: dto.name, link }),
      10000,
      { label: this.translate.instant(this.canShare ? 'party.share_link' : 'party.copy_link'), run: () => void this.shareLink(link, dto.name) },
    );
  }

  /** The system share sheet (Android WebView, iOS WKWebView and most browsers expose it). */
  readonly canShare = typeof navigator.share === 'function';

  /** Shares the link natively, else copies it. */
  async shareLink(link: string, title: string): Promise<void> {
    if (!this.canShare) return this.copyLink(link);
    try {
      await navigator.share({ title, url: link });
    } catch (e) {
      // Dismissing the sheet is not an error.
      if ((e as DOMException)?.name !== 'AbortError') await this.copyLink(link);
    }
  }

  async copyLink(link: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      this.toast.success(this.translate.instant('party.link_copied'));
    } catch {
      this.toast.error(this.translate.instant('party.error_generic'));
    }
  }

  inviteLink(token: string | null): string {
    // Native shells run on an app-local origin: the link must carry the server's.
    return token ? new URL(this.serverConfig.resolveUrl(`/party/${token}`), location.origin).href : '';
  }

  openPage(id: number, token?: string): void {
    void this.router.navigate(['/parties', id], token ? { queryParams: { token } } : {});
  }

  /** Invite link: resolve, then the player (live) or the page (scheduled). */
  async openByToken(token: string): Promise<void> {
    const dto = await this.api.byToken(token);
    if (dto.status === 'live') await this.enter(dto.id, token);
    else void this.router.navigate(['/parties', dto.id], { queryParams: { token }, replaceUrl: true });
  }

  /** Join: the player for a live party, the page (lobby) for a scheduled one whose lobby is open. */
  async enter(id: number, token?: string): Promise<void> {
    const dto = await this.api.join(id, this.deviceId(), token);
    if (!dto.live) {
      await this.api.leave(id, this.deviceId()).catch(() => {});
      this.toast.info(this.translate.instant('party.toast_not_started'));
      return;
    }
    this.reset();
    this.applySnapshot(dto);
    this.clock.start();
    if (dto.status === 'live') await this.openPlayer(dto.item);
    else this.openPage(id, token);
  }

  /** Host: leaves the lobby for the player; the other members follow through the events. */
  async start(): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    try {
      this.applySnapshot(await this.api.start(id));
      await this.openPlayer(this.party()!.item);
    } catch {
      /* the error interceptor already toasted it */
    }
  }

  async setReady(ready: boolean): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    const position = this.live()?.anchor.position ?? 0;
    await this.api.status(id, { deviceId: this.deviceId(), status: ready ? 'ready' : 'waiting', position }).catch(() => {});
  }

  async leave(): Promise<void> {
    const id = this.party()?.id;
    this.reset();
    if (id != null) await this.api.leave(id, this.deviceId()).catch(() => {});
  }

  private reset(): void {
    this.clock.stop();
    this.party.set(null);
    this.live.set(null);
    this.members.set([]);
    this.messages.set([]);
    this.bubbles.set([]);
    this.reactions.set([]);
    this.unread.set(0);
    this.panelOpen.set(false);
    this.lastRev = 0;
  }

  private async openPlayer(item: PartyItem): Promise<void> {
    let fileId = item.mediaFileId;
    if (fileId == null) {
      const media = await this.mediaService.getOne(item.mediaId).catch(() => null);
      fileId = media ? (resolvePlayableFile(media, item.episodeId ?? undefined)?.id ?? null) : null;
    }
    if (fileId == null) {
      this.toast.error(this.translate.instant('player.next_unavailable'));
      await this.leave();
      return;
    }
    const queryParams: Record<string, number> = { mediaId: item.mediaId };
    if (item.episodeId != null) queryParams['episodeId'] = item.episodeId;
    await this.router.navigate(['/watch', fileId], { queryParams });
  }

  // ── Snapshots ──

  applySnapshot(dto: PartyDto): void {
    this.party.set(dto);
    void this.reactionCatalog.load();
    const live = dto.live;
    if (!live) return;
    // A snapshot older than what events already applied would roll the party back.
    if (live.rev < this.lastRev) return;
    this.lastRev = live.rev;
    this.members.set(live.members);
    if (!this.messages().length) this.messages.set(live.messages);
    this.live.set({
      rev: live.rev,
      state: live.state,
      item: dto.item,
      anchor: live.anchor,
      whenMs: null,
      by: null,
      action: null,
    });
  }

  async refetch(): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    const wasLobby = this.lobby();
    try {
      const dto = await this.api.get(id);
      this.applySnapshot(dto);
      if (wasLobby && dto.status === 'live') await this.openPlayer(dto.item);
    } catch {
      /* the next event or reconnect retries */
    }
  }

  private async rejoin(): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    try {
      this.applySnapshot(await this.api.join(id, this.deviceId()));
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) this.onClosed('host_ended');
    }
  }

  // ── Events ──

  private onEvent(e: PartyEvent): void {
    switch (e.type) {
      case 'party.invited':
        this.onInvited(e);
        return;
      case 'party.starting':
        if (e.partyId === this.party()?.id) {
          void this.refetch();
          return;
        }
        this.toast.info(
          this.translate.instant('party.toast_starting', { name: e.name }),
          10000,
          { label: this.translate.instant('party.join'), run: () => void this.enter(e.partyId) },
        );
        return;
      case 'party.updated':
        if (e.partyId === this.party()?.id && this.lobby()) void this.refetch();
        return;
    }
    if (e.partyId !== this.party()?.id) return;
    // The host's start is not announced to members: the first event after it reveals it.
    if (this.lobby() && (e.type === 'party.state' || e.type === 'party.settings')) void this.refetch();
    switch (e.type) {
      case 'party.state':
        if (!this.acceptRev(e.rev)) return;
        this.live.set({
          rev: e.rev, state: e.state, item: e.item, anchor: e.anchor, whenMs: e.whenMs, by: e.by, action: e.action,
        });
        this.party.update((p) => (p ? { ...p, item: e.item } : p));
        break;
      case 'party.members':
        if (!this.acceptRev(e.rev)) return;
        this.members.set(e.members);
        break;
      case 'party.settings':
        if (!this.acceptRev(e.rev)) return;
        this.party.update((p) => (p ? { ...p, name: e.name, policy: e.policy } : p));
        break;
      case 'party.message':
        this.onMessage(e.message);
        break;
      case 'party.reaction':
        this.onReaction(e.emoji, e.username);
        break;
      case 'party.closed':
        this.onClosed(e.reason);
        break;
    }
  }

  /** Drops a stale event; a gap means we missed one, so the snapshot refetch fills it in. */
  private acceptRev(rev: number): boolean {
    if (rev <= this.lastRev) return false;
    const gap = rev > this.lastRev + 1;
    this.lastRev = rev;
    if (gap) void this.refetch();
    return true;
  }

  private onInvited(e: Extract<PartyEvent, { type: 'party.invited' }>): void {
    const immediate = !e.scheduledAt || new Date(e.scheduledAt).getTime() <= Date.now();
    this.toast.info(
      this.translate.instant('party.toast_invited', { host: e.host.username, name: e.name }),
      10000,
      immediate
        ? { label: this.translate.instant('party.join'), run: () => void this.enter(e.partyId) }
        : { label: this.translate.instant('party.view'), run: () => this.openPage(e.partyId) },
    );
  }

  private onMessage(m: PartyMessage): void {
    if (this.messages().some((x) => x.id === m.id)) return;
    this.messages.update((l) => [...l, m].slice(-MAX_MESSAGES));
    if (this.panelOpen() || m.system) return;
    this.unread.update((n) => n + 1);
    this.bubbles.update((l) => [...l, m].slice(-3));
    setTimeout(() => this.bubbles.update((l) => l.filter((x) => x.id !== m.id)), BUBBLE_MS);
  }

  private onReaction(emoji: string, username: string): void {
    const key = this.nextKey++;
    const reaction: FloatingReaction = { key, emoji, username, left: 10 + Math.random() * 80 };
    this.reactions.update((l) => [...l, reaction].slice(-12));
    setTimeout(() => this.reactions.update((l) => l.filter((x) => x.key !== key)), REACTION_MS);
  }

  private onClosed(reason: 'host_ended' | 'expired' | 'kicked'): void {
    this.reset();
    this.toast.info(this.translate.instant(`party.closed_${reason}`));
    this.closed.next(reason);
  }

  setReactionDock(on: boolean): void {
    this.reactionDock.set(on);
    writeFlag('party.reactionDock', on);
  }

  setReactionKeepOpen(on: boolean): void {
    this.reactionKeepOpen.set(on);
    writeFlag('party.reactionKeepOpen', on);
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen.set(open);
    if (!open) return;
    this.unread.set(0);
    this.bubbles.set([]);
  }

  // ── Actions ──

  /** Local engine actions are routed here in a party; the server decides and answers with `party.state`. */
  async sendIntent(
    action: PartyIntentAction,
    extra: { position?: number; item?: { mediaId: number; mediaFileId?: number; episodeId?: number } } = {},
  ): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    try {
      await this.api.intent(id, { deviceId: this.deviceId(), action, baseRev: this.lastRev, ...extra });
    } catch (err) {
      this.onActionError(err);
    }
  }

  async reportStatus(status: 'ready' | 'buffering', position: number): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    await this.api
      .status(id, { deviceId: this.deviceId(), status, position, rttMs: this.clock.rttMs() })
      .catch(() => {});
  }

  async sendMessage(text: string): Promise<void> {
    const id = this.party()?.id;
    const trimmed = text.trim();
    if (id == null || !trimmed) return;
    try {
      await this.api.sendMessage(id, this.deviceId(), trimmed);
    } catch (err) {
      this.onActionError(err);
    }
  }

  async react(emoji: string): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    await this.api.react(id, this.deviceId(), emoji).catch(() => {});
  }

  async kick(userId: number): Promise<void> {
    await this.hostAction((id) => this.api.kick(id, userId));
  }

  async makeHost(userId: number): Promise<void> {
    await this.hostAction((id) => this.api.transferHost(id, userId));
  }

  async setPolicy(policy: PartyPolicy): Promise<void> {
    await this.hostAction((id) => this.api.update(id, { policy }));
  }

  private async hostAction(run: (id: number) => Promise<unknown>): Promise<void> {
    const id = this.party()?.id;
    if (id == null) return;
    try {
      await run(id);
    } catch {
      /* the error interceptor already toasted it */
    }
  }

  /** Intent/message calls are quiet at the HTTP layer: a stale seek resyncs from the body, anything else is named to the user. */
  onActionError(err: unknown): void {
    if (!(err instanceof HttpErrorResponse)) return;
    const body = err.error as { message?: unknown; id?: number; usernames?: string[] } | null;
    if (err.status === 409 && (body?.message === 'party.error_stale' || typeof body?.id === 'number')) {
      if (typeof body?.id === 'number') this.applySnapshot(body as unknown as PartyDto);
      return;
    }
    const usernames = (body?.usernames ?? []).join(', ');
    const key = typeof body?.message === 'string' ? body.message : '';
    const text = key ? this.translate.instant(key, { usernames }) : null;
    this.toast.error(
      text && text !== key ? text : (translatedServerMessage(body?.message, this.translate) ?? this.translate.instant('party.error_generic')),
    );
  }
}
