import { Injectable, inject } from '@angular/core';
import { StreamingApiService } from './api/streaming-api.service';
import type { QoeEvent } from './api/qoe-api.service';

export const QOE_BUFFER_CAP = 100;
const MAX_PER_REQUEST = 50;

/** Buffers playback-quality events per session; every failure is swallowed. */
@Injectable({ providedIn: 'root' })
export class QoeReporter {
  private readonly api = inject(StreamingApiService);
  private readonly buffers = new Map<string, QoeEvent[]>();

  /** `immediate` flushes right away (a fatal error ends the heartbeat). */
  record(sessionId: string, event: QoeEvent, immediate = false): void {
    const buf = this.buffers.get(sessionId) ?? [];
    buf.push(event);
    if (buf.length > QOE_BUFFER_CAP) buf.shift();
    this.buffers.set(sessionId, buf);
    if (immediate) void this.flush(sessionId);
  }

  async flush(sessionId: string): Promise<void> {
    const events = this.take(sessionId);
    if (!events.length) return;
    try {
      for (let i = 0; i < events.length; i += MAX_PER_REQUEST) {
        await this.api.postQoeEvents(sessionId, events.slice(i, i + MAX_PER_REQUEST));
      }
    } catch {
      // best effort
    }
  }

  /** For exit and pagehide, where an HttpClient request would be cancelled. */
  flushKeepalive(sessionId: string): void {
    const events = this.take(sessionId);
    if (!events.length) return;
    try {
      for (let i = 0; i < events.length; i += MAX_PER_REQUEST) {
        const { url, init } = this.api.qoeEventsRequest(sessionId);
        fetch(url, { ...init, body: JSON.stringify({ events: events.slice(i, i + MAX_PER_REQUEST) }) }).catch(() => {});
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
