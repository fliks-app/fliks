import { Injectable, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { AuthService } from '../auth.service';
import { PartyService } from '../party/party.service';
import { ServerConfigService } from '../server-config.service';
import type { PitchFrame } from './karaoke-score';
import { decodeBatch } from './pitch-frames';

const RETRY_MS = 2000;

export type RelayRole = 'singer' | 'display';

/** Wire of a batch a display receives: the singer's batch stamped with their user id by the server. */
export function decodeRelayed(data: unknown): { userId: number; frames: PitchFrame[] } | null {
  if (typeof data !== 'string') return null;
  let u: unknown;
  try {
    u = (JSON.parse(data) as { u?: unknown }).u;
  } catch {
    return null;
  }
  const frames = decodeBatch(data);
  return typeof u === 'number' && frames.length ? { userId: u, frames } : null;
}

/** The party's karaoke relay socket (`/api/parties/:id/karaoke/ws`): singers send pitch batches, the host's display receives them. */
@Injectable({ providedIn: 'root' })
export class KaraokeRelayService {
  private readonly party = inject(PartyService);
  private readonly auth = inject(AuthService);
  private readonly config = inject(ServerConfigService);

  /** Batches that reached this display, with the singer's user id. */
  readonly received = new Subject<{ userId: number; frames: PitchFrame[] }>();
  private ws: WebSocket | null = null;
  private role: RelayRole | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Opens the socket for `role` and keeps it open until `close`. */
  open(role: RelayRole): void {
    if (this.role === role && this.ws) return;
    this.close();
    this.role = role;
    void this.dial();
  }

  /** With `only`, leaves a socket of the other role alone. */
  close(only?: RelayRole): void {
    if (only && this.role !== only) return;
    this.role = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /** False when the socket is not open. */
  send(data: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(data);
    return true;
  }

  private async dial(): Promise<void> {
    const role = this.role;
    const id = this.party.party()?.id;
    if (!role || id == null) return;
    const params = new URLSearchParams({ role });
    if (this.config.isNative) {
      const ticket = await this.auth.mintEventTicket();
      const token = this.auth.accessToken;
      if (ticket) params.set('ticket', ticket);
      else if (token) params.set('token', token);
      if (this.role !== role || this.ws) return;
    }
    const url = new URL(this.config.resolveUrl(`/api/parties/${id}/karaoke/ws`), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = params.toString();
    const ws = (this.ws = new WebSocket(url));
    ws.onmessage = (ev) => {
      const m = decodeRelayed(ev.data);
      if (m) this.received.next(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.role) this.timer = setTimeout(() => void this.dial(), RETRY_MS);
    };
  }
}
