import { signal } from '@angular/core';
import { LatestWins } from '../../core/utils/latest-wins';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';

export type LoadKind = 'launch' | 'resume';

/** Thrown into an op body once a newer op, or a leave, outdated it. */
export class LoadSuperseded extends Error {
  constructor() {
    super('load superseded');
    this.name = 'LoadSuperseded';
  }
}

export const isLoadSuperseded = (e: unknown): e is LoadSuperseded => e instanceof LoadSuperseded;

export interface LoaderHost {
  /** Deletes a server session, in page. */
  stopSession(sid: string): void;
  /** Whether a negotiation can retire the old session itself (`replaces`). */
  canReplace(): boolean;
  /** Tears down an engine no op owns; `releaseSurface` when no other op is running. */
  discardEngine(engine: PlaybackEngine, releaseSurface: boolean): void;
}

export interface LoadOp {
  readonly kind: LoadKind;
  stale(): boolean;
  /** Rejects `LoadSuperseded` once stale, so `this.x = await op.wait(p)` never writes for a dead op. */
  wait<T>(p: Promise<T>): Promise<T>;
  /** An engine that arrives stale is destroyed and its surface released. */
  engine<T extends { engine: PlaybackEngine }>(p: Promise<T>): Promise<T>;
  /** Records the answered session before the staleness check, commits it only if the op is current. */
  negotiate(
    call: (replaces?: string) => Promise<PlaybackInfoResponse>,
    opts?: { replace?: boolean },
  ): Promise<PlaybackInfoResponse>;
  /** `engine.load()` under `wait`; a stale op also unloads the engine, for those that cannot cancel a load. */
  load(engine: PlaybackEngine, ...args: Parameters<PlaybackEngine['load']>): Promise<void>;
}

/** Owns the sequencing of the player's first engine open: a newer op or a leave outdates the one running, and
 *  the session each negotiation opened stays accounted for. */
export class PlayerLoader {
  private readonly gen = new LatestWins();
  private running: number | null = null;
  private readonly committed = signal<PlaybackInfoResponse | null>(null);
  /** A session opened by an outdated op, kept for the next negotiation to replace. */
  private carried: string | undefined;

  readonly info = this.committed.asReadonly();

  constructor(private readonly host: LoaderHost) {}

  busy(): boolean {
    return this.running !== null;
  }

  /** The one session id this player holds. */
  sessionId(): string | undefined {
    return this.carried ?? this.committed()?.sessionId;
  }

  /** Commits an answer negotiated outside an op; `replaced` is the session that answer retired. */
  adopt(pi: PlaybackInfoResponse, replaced?: string): void {
    this.committed.set(pi);
    this.dropCarried(replaced);
  }

  forget(): void {
    this.committed.set(null);
  }

  /** The view is left: outdates the running op and deletes the session it can no longer deliver. */
  abort(): void {
    this.outdate();
    this.running = null;
    this.dropCarried();
  }

  /** Resolves with the body's value; `undefined` when the op was outdated. */
  async run<T>(kind: LoadKind, body: (op: LoadOp) => Promise<T>): Promise<T | undefined> {
    this.outdate();
    const token = this.gen.begin();
    this.running = token;
    const op = this.makeOp(kind, token);
    try {
      return await body(op);
    } catch (e) {
      if (op.stale()) return undefined;
      throw e;
    } finally {
      if (this.running === token) this.running = null;
    }
  }

  /** Outdates the running op and rejects whatever it waits on at once, so it never lingers on a slow call. */
  private outdate(): void {
    this.gen.cancel();
    this.kill?.();
    this.kill = undefined;
  }

  private kill: (() => void) | undefined;

  private makeOp(kind: LoadKind, token: number): LoadOp {
    const stale = () => !this.gen.isCurrent(token);
    const dead = new Promise<never>((_, reject) => (this.kill = () => reject(new LoadSuperseded())));
    dead.catch(() => {});
    const wait = <T>(p: Promise<T>): Promise<T> => {
      if (stale()) {
        p.catch(() => {});
        return Promise.reject(new LoadSuperseded());
      }
      return Promise.race([p, dead]);
    };
    return {
      kind,
      stale,
      wait,
      engine: (p) =>
        wait(
          p.then((surface) => {
            if (!stale()) return surface;
            this.host.discardEngine(surface.engine, this.running === null);
            throw new LoadSuperseded();
          }),
        ),
      negotiate: async (call, opts) => {
        if (stale()) throw new LoadSuperseded();
        const replaces = opts?.replace === false ? undefined : await this.retire();
        if (stale()) throw new LoadSuperseded();
        return wait(
          call(replaces).then((pi) => {
            if (stale()) {
              this.strand(pi.sessionId);
              throw new LoadSuperseded();
            }
            this.committed.set(pi);
            this.dropCarried(replaces);
            return pi;
          }),
        );
      },
      load: async (engine, ...args) => {
        try {
          await wait(engine.load(...args));
        } catch (e) {
          if (stale()) void engine.unload().catch(() => {});
          throw e;
        }
      },
    };
  }

  /** The id the next open replaces, or none after a stop where the server cannot do it inside the open. */
  private async retire(): Promise<string | undefined> {
    const sid = this.sessionId();
    if (!sid) return undefined;
    if (this.host.canReplace()) return sid;
    this.host.stopSession(sid);
    this.carried = undefined;
    return undefined;
  }

  /** An outdated op's open answered: a newer op still to negotiate replaces it, else it is deleted. */
  private strand(sid: string | undefined): void {
    if (!sid) return;
    if (this.running !== null && !this.committed()) {
      this.dropCarried();
      this.carried = sid;
    } else {
      this.host.stopSession(sid);
    }
  }

  /** Deletes the carried session unless `except` (the one a negotiation just replaced) already retired it. */
  private dropCarried(except?: string): void {
    if (this.carried && this.carried !== except) this.host.stopSession(this.carried);
    this.carried = undefined;
  }
}
