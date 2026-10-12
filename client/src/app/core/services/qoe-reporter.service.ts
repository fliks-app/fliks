import { Injectable, inject } from '@angular/core';
import { StreamingApiService } from './api/streaming-api.service';
import type { QoeEvent } from './api/qoe-api.service';

export const QOE_BUFFER_CAP = 100;

/** `crypto.randomUUID` needs a secure context; self-hosted installs are often plain http. */
export function newPlaybackId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const MAX_PER_REQUEST = 50;

/** Buffers playback-quality events per session; every failure is swallowed. */
@Injectable({ providedIn: 'root' })
export class QoeReporter {
  private readonly api = inject(StreamingApiService);
  private readonly buffers = new Map<string, QoeEvent[]>();
  private readonly playbackIds = new Map<string, string>();

  /** `immediate` flushes right away (a fatal error ends the heartbeat). */
  record(sessionId: string, event: QoeEvent, immediate = false, playbackId?: string): void {
    if (playbackId) this.playbackIds.set(sessionId, playbackId);
    const buf = this.buffers.get(sessionId) ?? [];
    buf.push(event);
    if (buf.length > QOE_BUFFER_CAP) buf.shift();
    this.buffers.set(sessionId, buf);
    if (immediate) void this.flush(sessionId);
  }

  async flush(sessionId: string): Promise<void> {
    const events = this.take(sessionId);
    if (!events.length) return;
    const playbackId = this.playbackIds.get(sessionId);
    try {
      for (let i = 0; i < events.length; i += MAX_PER_REQUEST) {
        await this.api.postQoeEvents(sessionId, events.slice(i, i + MAX_PER_REQUEST), playbackId);
      }
    } catch {
      // best effort
    }
  }

  /** For exit and pagehide, where an HttpClient request would be cancelled. */
  flushKeepalive(sessionId: string): void {
    const events = this.take(sessionId);
    if (!events.length) return;
    const playbackId = this.playbackIds.get(sessionId);
    try {
      for (let i = 0; i < events.length; i += MAX_PER_REQUEST) {
        const { url, init } = this.api.qoeEventsRequest(sessionId);
        const body = { events: events.slice(i, i + MAX_PER_REQUEST), playbackId };
        fetch(url, { ...init, body: JSON.stringify(body) }).catch(() => {});
      }
    } catch {
      // best effort
    }
  }

  private take(sessionId: string): QoeEvent[] {
    const events = this.buffers.get(sessionId) ?? [];
    this.buffers.delete(sessionId);
    return events;
  }
}
