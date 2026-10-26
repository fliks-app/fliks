import { Injectable, inject } from '@angular/core';
import { StreamingApiService } from './api/streaming-api.service';
import type { QoeEvent } from './api/qoe-api.service';

export const QOE_BUFFER_CAP = 100;

export function newPlaybackId(): string {
  return crypto.randomUUID();
}
const MAX_PER_REQUEST = 50;

/** Buffers playback-quality events per session; every failure is swallowed. */
@Injectable({ providedIn: 'root' })
export class QoeReporter {
  private readonly api = inject(StreamingApiService);
  private readonly buffers = new Map<string, { event: QoeEvent; playbackId?: string }[]>();

  /** `immediate` flushes right away (a fatal error ends the heartbeat). */
  record(sessionId: string, event: QoeEvent, immediate = false, playbackId?: string): void {
    const buf = this.buffers.get(sessionId) ?? [];
    buf.push({ event, playbackId });
    if (buf.length > QOE_BUFFER_CAP) buf.shift();
    this.buffers.set(sessionId, buf);
    if (immediate) void this.flush(sessionId);
  }

  async flush(sessionId: string): Promise<void> {
    try {
      for (const { events, playbackId } of this.take(sessionId)) {
        await this.api.postQoeEvents(sessionId, events, playbackId);
      }
    } catch {
      // best effort
    }
  }

  /** For exit and pagehide, where an HttpClient request would be cancelled. */
  flushKeepalive(sessionId: string): void {
    try {
      for (const { events, playbackId } of this.take(sessionId)) {
        const { url, init } = this.api.qoeEventsRequest(sessionId);
        fetch(url, { ...init, body: JSON.stringify({ events, playbackId, sentAt: Date.now() }) }).catch(() => {});
      }
    } catch {
      // best effort
    }
  }

  /** Requests of at most MAX_PER_REQUEST events, never mixing two playbacks. */
  private take(sessionId: string): { events: QoeEvent[]; playbackId?: string }[] {
    const buf = this.buffers.get(sessionId) ?? [];
    this.buffers.delete(sessionId);
    const out: { events: QoeEvent[]; playbackId?: string }[] = [];
    for (const { event, playbackId } of buf) {
      const last = out[out.length - 1];
      if (last && last.playbackId === playbackId && last.events.length < MAX_PER_REQUEST) last.events.push(event);
      else out.push({ events: [event], playbackId });
    }
    return out;
  }
}
