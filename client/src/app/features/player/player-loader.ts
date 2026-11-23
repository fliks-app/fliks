import { signal } from '@angular/core';
import { LatestWins } from '../../core/utils/latest-wins';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import type { PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import type { ReloadWhy } from './player-qoe';

export type LoadKind = 'launch' | 'resume' | 'reload' | 'switch' | 'recover';

export type LoadOutcome = 'done' | 'superseded' | 'failed';

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
  /** An op of this kind settled and is still the current one. */
  ended(kind: LoadKind): void;
}

export interface LoadOp {
  readonly kind: LoadKind;
  stale(): boolean;
  /** Throws `LoadSuperseded` once stale: the guard before a step that has no await of its own. */
  check(): void;
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
  /** The load has landed: a seek made from now on goes to the engine. */
  loaded(): void;
  /** Where the load starts: a seek the viewer made meanwhile beats `computed`. */
  start(computed: number | undefined): number | undefined;
  /** The seek the viewer made while this op ran; undefined when none. */
  aimed(): number | undefined;
  /** Work that follows the load without owning the engine: runs once this op has ended, dropped if a newer one started. */
  after(fn: () => Promise<unknown>): void;
}

/** What a reload asks for; one asked while an op runs waits in a single slot, the newest `why` wins and `at` is kept. */
export interface ReloadRequest {
  at?: number;
  why?: ReloadWhy;
}

interface Slot {
  req: ReloadRequest;
  body: (op: LoadOp, req: ReloadRequest) => Promise<void>;
  waiters: Array<(o: LoadOutcome) => void>;
}

/** The one owner of the player's engine loads: a newer op or a leave outdates the one running, the session each
 *  negotiation opened stays accounted for, and every "is a load busy" question is answered here. */
export class PlayerLoader {
  private readonly gen = new LatestWins();
  private running: { token: number; kind: LoadKind } | null = null;
  private readonly committed = signal<PlaybackInfoResponse | null>(null);
  /** The committed session is this player's to stop: false after a hand-off or once the server retired it. */
  private owned = false;
  /** A session opened by an outdated op, or let go by `forget`, kept for the next negotiation to replace. */
  private carried: string | undefined;
  private slot: Slot | null = null;
  private afterWork: Array<() => Promise<unknown>> = [];
  /** A seek made while a load that takes seeks runs: where that load starts. */
  private target: number | undefined;
  private takesSeeks = false;
  private landed = false;
  /** Handed to another output: nothing loads here until a launch or resume brings the player back. */
  private released = false;
  private kill: (() => void) | undefined;

  readonly info = this.committed.asReadonly();

  constructor(private readonly host: LoaderHost) {}

  busy(): boolean {
    return this.running !== null;
  }

  kind(): LoadKind | null {
    return this.running?.kind ?? null;
  }

  /** The one session id this player holds. */
  sessionId(): string | undefined {
    return this.carried ?? (this.owned ? this.committed()?.sessionId : undefined);
  }

  /** The info of the committed session goes; its id, if still owned, is carried for the next negotiation to replace. */
  forget(): void {
    const sid = this.committed()?.sessionId;
    if (this.owned && sid) {
      this.dropCarried();
      this.carried = sid;
    }
    this.owned = false;
    this.committed.set(null);
  }

  /** The view is left: outdates the running op, deletes the session it can no longer deliver and loads nothing more. */
  abort(): void {
    this.drop();
    this.dropCarried();
    this.released = true;
  }

  /** Another output plays and this device may come back: the running op ends, the session stays. */
  supersede(): void {
    this.drop();
  }

  /** The playback moves to another output: the running op ends and the session id leaves with it. */
  handOff(): string | undefined {
    this.drop();
    const sid = this.sessionId();
    this.carried = undefined;
    this.owned = false;
    this.released = true;
    return sid;
  }

  /** A seek made while a load that takes seeks runs replaces where that load starts; false when it is not one. */
  seek(t: number): boolean {
    if (!this.running || !this.takesSeeks || this.landed) return false;
    this.target = t;
    return true;
  }

  /** A launch, resume or switch: outdates whatever runs and the slot, resolves the body's value, `undefined` when outdated. */
  async run<T>(
    kind: 'launch' | 'resume' | 'switch',
    body: (op: LoadOp) => Promise<T>,
    takesSeeks = false,
  ): Promise<T | undefined> {
    if (kind === 'switch' && this.released) return undefined;
    if (kind !== 'switch') this.released = false;
    this.clearSlot('superseded');
    return this.start(kind, body, takesSeeks);
  }

  /** A recovery's load: yields to any load running, since that one owns the session. */
  async recover<T>(body: (op: LoadOp) => Promise<T>): Promise<T | undefined> {
    if (this.running || this.released) return undefined;
    return this.start('recover', body, true);
  }

  /** A reload: runs now, or waits in the one slot while a load runs; resolves with the outcome of the op that ran it. */
  reload(req: ReloadRequest, body: (op: LoadOp, req: ReloadRequest) => Promise<void>): Promise<LoadOutcome> {
    if (this.released) return Promise.resolve('superseded');
    if (this.running) {
      return new Promise<LoadOutcome>((resolve) => {
        const prev = this.slot;
        this.slot = {
          req: { why: req.why, at: req.at ?? prev?.req.at },
          body,
          waiters: [...(prev?.waiters ?? []), resolve],
        };
      });
    }
    return this.runReload(req, body);
  }

  private async runReload(req: ReloadRequest, body: Slot['body']): Promise<LoadOutcome> {
    try {
      const ran = await this.start('reload', async (op) => {
        await body(op, req);
        return true;
      }, true);
      return ran ? 'done' : 'superseded';
    } catch (e) {
      console.error('[player] reload failed', e);
      return 'failed';
    }
  }

  private async start<T>(kind: LoadKind, body: (op: LoadOp) => Promise<T>, takesSeeks: boolean): Promise<T | undefined> {
    this.outdate();
    const token = this.gen.begin();
    this.running = { token, kind };
    this.takesSeeks = takesSeeks;
    this.landed = false;
    this.target = undefined;
    this.afterWork = [];
    const op = this.makeOp(kind, token);
    let result: T | undefined;
    try {
      result = await body(op);
    } catch (e) {
      if (!op.stale()) throw e;
      result = undefined;
    } finally {
      if (this.running?.token === token) {
        this.running = null;
        this.host.ended(kind);
        this.settle();
      }
    }
    return result;
  }

  /** Runs what the finished op left to do, then the reload that waited; a newer op started meanwhile drops both. */
  private settle(): void {
    const work = this.afterWork;
    this.afterWork = [];
    for (const fn of work) {
      if (this.running) return;
      void fn().catch((e) => console.warn('[player] post-load step failed', e));
    }
    const slot = this.slot;
    if (!slot || this.running) return;
    this.slot = null;
    void this.runReload(slot.req, slot.body).then((o) => slot.waiters.forEach((w) => w(o)));
  }

  private clearSlot(outcome: LoadOutcome): void {
    const slot = this.slot;
    this.slot = null;
    slot?.waiters.forEach((w) => w(outcome));
  }

  /** The running op and what waits behind it end; the session stays accounted for. */
  private drop(): void {
    this.outdate();
    this.running = null;
    this.afterWork = [];
    this.clearSlot('superseded');
  }

  /** Outdates the running op and rejects whatever it waits on at once, so it never lingers on a slow call. */
  private outdate(): void {
    this.gen.cancel();
    this.kill?.();
    this.kill = undefined;
  }

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
      check: () => {
        if (stale()) throw new LoadSuperseded();
      },
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
        const answer = call(replaces).then(
          (pi) => {
            if (stale()) {
              this.strand(pi.sessionId, replaces);
              throw new LoadSuperseded();
            }
            this.commit(pi, replaces);
            return pi;
          },
          (e) => {
            if (!stale()) this.openFailed(replaces);
            throw e;
          },
        );
        return wait(answer);
      },
      load: async (engine, ...args) => {
        try {
          await wait(engine.load(...args));
        } catch (e) {
          if (stale()) void engine.unload().catch(() => {});
          throw e;
        }
      },
      loaded: () => {
        this.landed = true;
      },
      start: (computed) => this.target ?? computed,
      aimed: () => this.target,
      after: (fn) => {
        if (!stale()) this.afterWork.push(fn);
      },
    };
  }

  private commit(pi: PlaybackInfoResponse, replaces: string | undefined): void {
    this.committed.set(pi);
    this.owned = true;
    this.dropCarried(replaces);
  }

  /** The id the next open replaces, or none after a stop where the server cannot do it inside the open. */
  private async retire(): Promise<string | undefined> {
    const sid = this.sessionId();
    if (!sid) return undefined;
    if (this.host.canReplace()) return sid;
    this.host.stopSession(sid);
    this.ended(sid);
    return undefined;
  }

  /** An open that failed before it could retire `replaces` leaves that session to its TTL: stop it. */
  private openFailed(replaces: string | undefined): void {
    if (!replaces) return;
    this.host.stopSession(replaces);
    this.ended(replaces);
  }

  /** An outdated op's open answered: the next negotiation replaces it when this open retired `replaced`, else it is deleted. */
  private strand(sid: string | undefined, replaced: string | undefined): void {
    if (!sid) return;
    this.ended(replaced);
    if (replaced !== undefined && this.running !== null) {
      this.dropCarried();
      this.carried = sid;
    } else {
      this.host.stopSession(sid);
    }
  }

  /** `sid` is gone from the server: it is no longer this player's to replace or stop. */
  private ended(sid: string | undefined): void {
    if (!sid) return;
    if (this.carried === sid) this.carried = undefined;
    if (this.committed()?.sessionId === sid) this.owned = false;
  }

  /** Deletes the carried session unless `except` (the one a negotiation just replaced) already retired it. */
  private dropCarried(except?: string): void {
    if (this.carried && this.carried !== except) this.host.stopSession(this.carried);
    this.carried = undefined;
  }
}
