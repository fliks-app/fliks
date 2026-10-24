import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';

export type PartyStatus = 'scheduled' | 'live' | 'ended';
export type PartyPolicy = 'everyone' | 'host_only';
export type PartyPlayState = 'idle' | 'waiting' | 'paused' | 'playing';
export type PartyMemberStatus = 'ready' | 'buffering' | 'away' | 'waiting';
export type PartyIntentAction = 'play' | 'pause' | 'seek' | 'setItem' | 'ended';

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

export interface PartyLive {
  rev: number;
  state: PartyPlayState;
  anchor: PartyAnchor;
  members: PartyMember[];
  messages: PartyMessage[];
}

export interface PartySummaryDto {
  id: number;
  name: string;
  status: PartyStatus;
  scheduledAt: string | null;
  host: PartyUser;
  item: PartyItem;
  memberCount: number;
}

export interface PartyDto extends PartySummaryDto {
  policy: PartyPolicy;
  inviteToken: string | null;
  invitees: PartyUser[];
  live: PartyLive | null;
}

export interface CreatePartyBody {
  name: string;
  mediaId: number;
  mediaFileId?: number;
  episodeId?: number;
  scheduledAt?: string;
  policy?: PartyPolicy;
  inviteeIds?: number[];
}

export interface PartyIntentBody {
  deviceId: string;
  action: PartyIntentAction;
  position?: number;
  item?: { mediaId: number; mediaFileId?: number; episodeId?: number };
  baseRev: number;
}

/** Calls the caller reports itself (a stale seek is expected, a status beacon is noise). */
const QUIET = () => ({ context: new HttpContext().set(SKIP_ERROR_TOAST, true) });

@Injectable({ providedIn: 'root' })
export class PartyApiService {
  private readonly http = inject(HttpClient);

  create(body: CreatePartyBody) {
    return firstValueFrom(this.http.post<PartyDto>('/api/parties', body));
  }

  list() {
    return firstValueFrom(this.http.get<PartySummaryDto[]>('/api/parties'));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<PartyDto>(`/api/parties/${id}`));
  }

  byToken(token: string) {
    return firstValueFrom(this.http.get<PartyDto>(`/api/parties/by-token/${encodeURIComponent(token)}`));
  }

  update(id: number, body: { name?: string; policy?: PartyPolicy; scheduledAt?: string | null; regenerateToken?: boolean }) {
    return firstValueFrom(this.http.patch<PartyDto>(`/api/parties/${id}`, body));
  }

  end(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/parties/${id}`));
  }

  join(id: number, deviceId: string, token?: string) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/join`, { deviceId, ...(token && { token }) }));
  }

  start(id: number) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/start`, {}));
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
    return firstValueFrom(this.http.post<PartyMessage>(`/api/parties/${id}/messages`, { deviceId, text }));
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

  signal(id: number, deviceId: string, to: string, kind: PartySignalKind, data: object) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/signal`, { deviceId, to, kind, data }, QUIET()));
  }

  react(id: number, deviceId: string, emoji: string) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/reactions`, { deviceId, emoji }, QUIET()));
  }

  kick(id: number, userId: number) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/members/${userId}/kick`, {}));
  }

  transferHost(id: number, userId: number) {
    return firstValueFrom(this.http.post<void>(`/api/parties/${id}/members/${userId}/host`, {}));
  }

  invite(id: number, userIds: number[]) {
    return firstValueFrom(this.http.post<PartyDto>(`/api/parties/${id}/invitees`, { userIds }));
  }
}
