import { Injectable, Logger } from '@nestjs/common';
import { bridgeConfigured, bridgeFetch } from '../bridge/server-bridge';

/** The viewer as a QoE session (live TV: kind 'live', the channel as title). */
export interface SessionRef {
  sessionId: string;
  userId: number | null;
  mediaFileId: number | null;
  mediaTitle: string | null;
  startedAt: number;
  lastBeat: number;
  deviceLabel: string | null;
  systemName: string | null;
  appVersion: string | null;
  kind: 'live';
  quality: string | null;
  transcodeReasons: unknown[];
  state: 'playing' | 'paused';
  attributedUserId: number | null;
}

/** Forwards live TV's QoE calls to fliks-server (`/internal/qoe/*`, S2 to S7): the trackers live there. */
@Injectable()
export class QoeService {
  private readonly log = new Logger(QoeService.name);
  private probe: (() => number) | null = null;
  private pushedTranscodes = 0;

  addTranscodeProbe(probe: () => number): void {
    this.probe = probe;
  }

  /** `pipeline` is the engine's report as is; fliks-server maps it. */
  register(session: SessionRef, pipeline: unknown): void {
    this.post('register', { session, pipeline });
  }

  /** `qoe` is the client's raw sample; fliks-server validates it. */
  recordSample(session: SessionRef, qoe: unknown): void {
    this.post('live-sample', { session, state: session.state, qoe });
  }

  observeServed(session: SessionRef, cmcdRaw: string | undefined, segmentDurationS: number, waitedMs: number | null): void {
    this.post('served', { session, cmcdRaw: cmcdRaw ?? null, segmentDurationS, waitedMs });
  }

  sessionEnded(session: Pick<SessionRef, 'sessionId'>): void {
    this.post('session-ended', { sessionId: session.sessionId });
  }

  /** `null` when fliks-server does not track the session. */
  async liveSummary(sessionId: string): Promise<unknown | null> {
    try {
      return await bridgeFetch(`/internal/qoe/live-summary?sessionId=${encodeURIComponent(sessionId)}`);
    } catch {
      return null;
    }
  }

  private post(endpoint: string, body: unknown): void {
    if (!bridgeConfigured()) return;
    const run = async () => {
      await bridgeFetch(`/internal/qoe/${endpoint}`, { method: 'POST', body });
      const n = this.probe?.() ?? 0;
      if (n !== this.pushedTranscodes) {
        await bridgeFetch('/internal/qoe/transcode-probe', { method: 'POST', body: { count: n } });
        this.pushedTranscodes = n;
      }
    };
    run().catch((e: Error) => this.log.warn(`qoe ${endpoint}: ${e.message}`));
  }
}
