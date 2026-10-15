import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EngineService, type EngineEvent } from '../../engine/engine.service';
import { readCmcdRaw } from '../../qoe/core/cmcd';
import { QoeService } from '../../qoe/qoe.service';
import { StreamingSettingsCache } from '../streaming-settings-cache.service';
import { LiveSessionRegistry } from '../live-session.service';
import { servedRungBitrate } from '../served-rung';
import { realSegmentSeconds } from '../../media-tools/fps';
import { jobKeyOf, restorePresence } from './engine-presence';

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
/** The engine pings every 15 s: silence past this is a dead connection. */
const IDLE_MS = 45_000;

/** The `data:` payloads of an SSE body, one per event; `onBytes` hears every chunk, keep-alives included. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  onBytes: () => void = () => undefined,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const text = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onBytes();
    buf += text.decode(value, { stream: true });
    for (
      let end = buf.search(/\r?\n\r?\n/);
      end >= 0;
      end = buf.search(/\r?\n\r?\n/)
    ) {
      const block = buf.slice(0, end);
      buf = buf.slice(end).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

/** Follows `GET /v1/events` and keeps the app's view of the engine's sessions in step: presence,
 *  remote control, QoE signals and the load counters, and settles the engine's background jobs. Resyncs from `GET /v1/sessions` on every (re)connect. */
@Injectable()
export class EngineEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EngineEventsService.name);
  private abort: AbortController | null = null;
  private readonly jobs = new Set<string>();
  private readonly listeners: ((ev: EngineEvent) => void)[] = [];
  private readonly resyncListeners: (() => Promise<void>)[] = [];
  protected sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(t), resolve()), {
        once: true,
      });
    });

  constructor(
    private readonly engine: EngineService,
    private readonly liveSessions: LiveSessionRegistry,
    private readonly qoe: QoeService,
    private readonly settings: StreamingSettingsCache,
  ) {}

  onModuleInit(): void {
    void this.engine.whenReady().then(() => this.restart());
    this.engine.onConnect(() => this.restart());
  }

  onModuleDestroy(): void {
    this.abort?.abort();
  }

  /** Hears every event, for the parts of the app (live TV) that own their own session state. */
  onEvent(listener: (ev: EngineEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Runs after every (re)connect's resync, like the presence one. */
  onResync(listener: () => Promise<void>): void {
    this.resyncListeners.push(listener);
  }

  /** Running ffmpeg jobs, for the QoE load probe. */
  get activeJobs(): number {
    return this.jobs.size;
  }

  /** (Re)starts the follower: the engine is new, or it is the first time it is known to run playback. */
  restart(): void {
    this.abort?.abort();
    this.abort = null;
    if (!this.engine.runtime) return;
    this.abort = new AbortController();
    void this.run(this.abort.signal);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      const conn = new AbortController();
      const stop = () => conn.abort();
      signal.addEventListener('abort', stop, { once: true });
      let idle: NodeJS.Timeout | undefined;
      const watch = () => {
        clearTimeout(idle);
        idle = setTimeout(stop, IDLE_MS);
        idle.unref();
      };
      try {
        const res = await this.engine.events(conn.signal);
        if (!res.ok || !res.body)
          throw new Error(`GET /v1/events -> ${res.status}`);
        watch();
        // Subscribed before listing: an event between the two is replayed, never lost.
        await this.resync();
        backoff = MIN_BACKOFF_MS;
        for await (const data of sseData(res.body, watch)) {
          this.handle(JSON.parse(data) as EngineEvent);
        }
      } catch (err) {
        if (!signal.aborted)
          this.log.warn(`engine events: ${(err as Error).message}`);
      } finally {
        clearTimeout(idle);
        signal.removeEventListener('abort', stop);
        conn.abort();
      }
      await this.sleep(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** Presence and job counters from the engine's sessions; presence the engine no longer holds goes. */
  async resync(): Promise<void> {
    const listedAt = Date.now();
    const snaps = await this.engine.listSessions();
    const known = new Set(snaps.map((s) => s.sessionId));
    for (const s of snaps)
      if (!this.liveSessions.peek(s.sessionId))
        restorePresence(this.liveSessions, s);
    // One opened since the list was taken is not stale, only newer than it.
    for (const p of this.liveSessions.list()) {
      if (!known.has(p.sessionId) && p.startedAt.getTime() < listedAt)
        this.liveSessions.stop(p.sessionId);
    }
    this.jobs.clear();
    for (const s of snaps)
      if (s.job?.state === 'running') this.jobs.add(jobKeyOf(s));
    await this.engine.resyncJobs();
    await Promise.all(this.resyncListeners.map((l) => l()));
  }

  handle(ev: EngineEvent): void {
    for (const l of this.listeners) l(ev);
    switch (ev.type) {
      case 'SessionOpened':
        if (!this.liveSessions.peek(ev.session.sessionId))
          restorePresence(this.liveSessions, ev.session);
        break;
      case 'SessionEnded':
        this.liveSessions.stop(ev.sessionId);
        break;
      // ponytail: a throttle-paused job still counts, the engine emits no pause event
      case 'JobStarted':
        this.jobs.add(ev.jobKey);
        break;
      case 'JobEnded':
        this.jobs.delete(ev.jobKey);
        break;
      case 'BgJobProgress':
        this.engine.jobProgress(ev.jobId, ev.pct);
        break;
      case 'BgJobDone':
        this.engine.jobEnded(ev.jobId, ev);
        break;
      case 'PipelineChanged': {
        const live = this.liveSessions.peek(ev.sessionId);
        if (!live) break;
        if (live.kind === 'transcode') {
          this.qoe.noteServedRung(
            live,
            ev.quality,
            servedRungBitrate({ ...live, quality: ev.quality }),
          );
        }
        this.qoe.noteHwAccel(live, ev.hwAccel);
        break;
      }
      case 'SegmentServed': {
        const live = this.liveSessions.peek(ev.sessionId);
        if (!live) break;
        this.qoe.observeServed(
          live,
          ev.cmcdRaw ? readCmcdRaw(ev.cmcdRaw) : null,
          realSegmentSeconds(
            this.settings.segmentDuration,
            live.sourceFps ?? undefined,
          ),
          ev.waitedMs,
        );
        break;
      }
    }
  }
}
