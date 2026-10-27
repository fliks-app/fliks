import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { ServerVersionService } from '../server-version.service';

export type PartyStatus = 'scheduled' | 'live' | 'ended';
export type PartyPolicy = 'everyone' | 'host_only';
export type PartyPlayState = 'idle' | 'waiting' | 'paused' | 'playing';
export type PartyMemberStatus = 'ready' | 'buffering' | 'away' | 'waiting';
export type PartyIntentAction = 'play' | 'pause' | 'seek' | 'setItem' | 'ended' | 'next' | 'previous';

export interface PartyReactionCatalog {
  animations: Record<string, string>;
  defaults: string[];
}

export interface PartyItem {
  mediaId: number;
  mediaFileId: number | null;
  episodeId: number | null;
  title: string;
  posterUrl: string | null;
  fanartUrl: string | null;
  additionalFanartUrls: string[];
  /** Episode only, null for a movie or a masked row. */
  stillUrl: string | null;
  seriesTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  /** A programme row the viewer cannot open: masked, but still part of the list the host sends back. */
  hidden: boolean;
}

export interface PartyUser {
  userId: number;
  username: string;
}

export interface PartyAnchor {
  position: number;
  serverTimeMs: number;
}

export interface PartyMember extends PartyUser {
  deviceId: string;
  role: 'host' | 'member';
  status: PartyMemberStatus;
  deviceName: string | null;
  formFactor: string | null;
  /** In the voice channel (null = not in it). */
  voice: { muted: boolean } | null;
}

export type PartySignalKind = 'offer' | 'answer' | 'ice' | 'bye';

export interface PartyMessage {
  id: number;
  userId: number | null;
  username: string | null;
  text: string;
  system: { kind: string; by: string | null; args: Record<string, unknown> } | null;
  sentAtMs: number;
}

/** What plays; absent before the host starts the party. */
export interface PartyPlayback {
  state: PartyPlayState;
  anchor: PartyAnchor;
}

export interface PartyLive {
  rev: number;
  playback: PartyPlayback | null;
  members: PartyMember[];
  messages: PartyMessage[];
}

export interface PartyPlaylistRef {
  id: number;
  name: string;
}

/** A programme item the host picked to stand for the party. */
export interface PartyCoverRef {
  mediaId: number;
  episodeId?: number;
}

/** What the host sends: a programme item or 2 to 4 of them as a mosaic. */
export type PartyCoverChoice = { kind: 'item' } & PartyCoverRef | { kind: 'mosaic'; items: PartyCoverRef[] };

/** The host's picture for the party; null = automatic (the programme head's poster). */
export type PartyCover = { kind: 'item'; item: PartyItem } | { kind: 'mosaic'; items: PartyItem[] } | { kind: 'upload'; url: string } | null;

export interface PartySummaryDto {
  id: number;
  name: string;
  status: PartyStatus;
  scheduledAt: string | null;
  /** When the lobby opens, on the server's clock. */
  host: PartyUser;
  /** The playing item, else the programme head; null while the programme is empty. masked (`hidden`) when the viewer cannot open it. */
  item: PartyItem | null;
  /** The playlist the party follows; the server picks what plays next from it. */
  playlist: PartyPlaylistRef | null;
  memberCount: number;
  public: boolean;
  cover: PartyCover;
}

/** The host's party-wide switches. */
export interface PartySwitches {
  policy: PartyPolicy;
  reactionsEnabled: boolean;
  chatEnabled: boolean;
  linkSharing: boolean;
  /** Visible to every user holding `parties.read_public`. */
  public: boolean;
}

export type PartyGuestSource = 'invite' | 'link' | 'public';

export interface PartyGuest extends PartyUser {
  source: PartyGuestSource;
}

/** A film put forward by a member; `item.hidden` when the viewer cannot open it. */
export interface PartyProposal {
  id: number;
  item: PartyItem;
  proposedBy: number;
  upvoterIds: number[];
  downvoterIds: number[];
}

export interface PartyDto extends PartySummaryDto, PartySwitches {
  inviteToken: string | null;
  guests: PartyGuest[];
  proposals: PartyProposal[];
  live: PartyLive | null;
}

/** What a non-member gets for an invite link: the summary alone. */
export type PartyPreview = PartySummaryDto & Partial<PartyDto>;

export interface CreatePartyBody {
  name: string;
  mediaId?: number;
  mediaFileId?: number;
  episodeId?: number;
  playlistId?: number;
  scheduledAt?: string;
  policy?: PartyPolicy;
  reactionsEnabled?: boolean;
  chatEnabled?: boolean;
  linkSharing?: boolean;
  public?: boolean;
  inviteeIds?: number[];
  items?: { mediaId: number; mediaFileId?: number; episodeId?: number }[];
  cover?: PartyCoverChoice;
}

export interface PartyIntentBody {
  deviceId: string;
  action: PartyIntentAction;
  position?: number;
  item?: { mediaId: number; mediaFileId?: number; episodeId?: number };
  baseRev: number;
}

const PARTY_SINCE = '5.2.0';

/** Calls the caller reports itself (a stale seek is expected, a status beacon is noise, a lost room is rejoined). */
const QUIET = () => ({ context: new HttpContext().set(SKIP_ERROR_TOAST, true) });

@Injectable({ providedIn: 'root' })
export class PartyApiService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly serverVersion = inject(ServerVersionService);

  supported(): boolean {
    return this.serverVersion.supports(PARTY_SINCE);
  }

  canCreate(): boolean {
    return this.supported() && this.auth.hasPermission('parties.create');
  }

  create(body: CreatePartyBody) {
    return firstValueFrom(this.http.post<PartyDto>('/api/parties', body));
  }

  select(id: number, body: { mediaId: number; mediaFileId?: number; episodeId?: number }) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/select`, body));
  }

  programme(id: number, items: { mediaId: number; mediaFileId?: number; episodeId?: number }[]) {
    return firstValueFrom(this.http.put<PartyDto>(`/api/parties/${id}/programme`, { items }));
  }

  uploadCover(id: number, image: Blob) {
    const form = new FormData();
    form.append('file', image);
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/cover`, form));
  }

  removeCover(id: number) {
    return firstValueFrom(this.http.delete<PartyDto>(`/api/parties/${id}/cover`));
  }

  queue(id: number, quiet = false) {
    return firstValueFrom(this.http.get<PartyItem[]>(`/api/parties/${id}/queue`, quiet ? QUIET() : {}));
  }

  async list(): Promise<PartySummaryDto[]> {
    if (!(await this.serverVersion.supportsWhenKnown(PARTY_SINCE))) return [];
    return firstValueFrom(this.http.get<PartySummaryDto[]>('/api/parties'));
  }

  get(id: number, quiet = false) {
    return firstValueFrom(this.http.get<PartyDto>(`/api/parties/${id}`, quiet ? QUIET() : {}));
  }

  byToken(token: string) {
    return firstValueFrom(this.http.get<PartyPreview>(`/api/parties/by-token/${encodeURIComponent(token)}`));
  }

  update(id: number, body: Partial<PartySwitches> & { name?: string; scheduledAt?: string | null; regenerateToken?: boolean; cover?: PartyCoverChoice | null }, quiet = false) {
    return firstValueFrom(this.http.patch<PartyDto>(`/api/parties/${id}`, body, quiet ? QUIET() : {}));
  }

  /** A guest leaves the party for good; a 404 means they already had. */
  quit(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/quit`, {}, QUIET())).catch((e) => {
      if (e?.status !== 404) throw e;
    });
  }

  end(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/parties/${id}`));
  }

  join(id: number, deviceId: string, token?: string, quiet = false) {
    return firstValueFrom(
      this.http.post<PartyDto>(`/api/parties/${id}/join`, { deviceId, ...(token && { token }) }, quiet ? QUIET() : {}),
    );
  }

  proposeMany(id: number, items: { mediaId: number; episodeId: number | null }[]) {
    const body = { items: items.map(({ mediaId, episodeId }) => ({ mediaId, ...(episodeId != null && { episodeId }) })) };
    return firstValueFrom(this.http.post<PartyProposal[]>(`/api/parties/${id}/proposals/batch`, body));
  }

  unpropose(id: number, proposalId: number) {
    return firstValueFrom(this.http.delete<void>(`/api/parties/${id}/proposals/${proposalId}`));
  }

  /** `null` clears the caller's vote. */
  vote(id: number, proposalId: number, value: 1 | -1 | null) {
    const url = `/api/parties/${id}/proposals/${proposalId}/vote`;
    return firstValueFrom(value === null ? this.http.delete<void>(url) : this.http.put<void>(url, { value }));
  }

  choose(id: number, proposalId: number) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/proposals/${proposalId}/choose`, {}));
  }

  start(id: number) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/start`, {}, QUIET()));
  }

  leave(id: number, deviceId: string) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/leave`, { deviceId }, QUIET()));
  }

  intent(id: number, body: PartyIntentBody) {
    return firstValueFrom(this.http.post<{ rev: number }>(`/api/parties/${id}/intent`, body, QUIET()));
  }

  status(id: number, body: { deviceId: string; status: 'ready' | 'buffering' | 'waiting'; position: number; rttMs?: number }) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/status`, body, QUIET()));
  }

  sendMessage(id: number, deviceId: string, text: string) {
    return firstValueFrom(this.http.post<PartyMessage>(`/api/parties/${id}/messages`, { deviceId, text }, QUIET()));
  }

  iceServers() {
    return firstValueFrom(this.http.get<{ iceServers: RTCIceServer[] }>('/api/parties/ice', QUIET()));
  }

  reactionCatalog() {
    return firstValueFrom(this.http.get<PartyReactionCatalog>('/api/parties/reactions', QUIET()));
  }

  voice(id: number, deviceId: string, joined: boolean, muted: boolean) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/voice`, { deviceId, joined, muted }, QUIET()));
  }

  /** Voice release for a page going away, where an Angular request is dropped. Bypasses HttpClient, so the URL and Bearer header are resolved here. */
  leaveVoiceOnUnload(id: number, deviceId: string): void {
    const path = `/api/parties/${id}/voice`;
    const native = this.serverConfig.isNative;
    const token = native ? this.auth.accessToken : null;
    void fetch(native ? this.serverConfig.resolveUrl(path) : path, {
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ deviceId, joined: false, muted: true }),
    }).catch(() => {});
  }

  signal(id: number, deviceId: string, to: string, kind: PartySignalKind, data: object) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/signal`, { deviceId, to, kind, data }, QUIET()));
  }

  react(id: number, deviceId: string, emoji: string) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/reactions`, { deviceId, emoji }, QUIET()));
  }

  kick(id: number, userId: number) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/members/${userId}/kick`, {}, QUIET()));
  }

  transferHost(id: number, userId: number) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/members/${userId}/host`, {}, QUIET()));
  }

  invite(id: number, userIds: number[]) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/invitees`, { userIds }));
  }
}
