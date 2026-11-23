import { describe, expect, it, vi } from 'vitest';
import { PlayerLoader, isLoadSuperseded, type LoadOp, type LoaderHost } from './player-loader';
import type { ReloadWhy } from './player-qoe';
import type { PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import type { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';

const pi = (sessionId: string) => ({ sessionId }) as PlaybackInfoResponse;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function setup(canReplace = true) {
  const host = {
    stopSession: vi.fn(),
    canReplace: vi.fn(() => canReplace),
    discardEngine: vi.fn(),
    ended: vi.fn(),
  } satisfies LoaderHost;
  return { host, loader: new PlayerLoader(host) };
}

const flush = () => new Promise<void>((r) => setTimeout(r));
const why = (reason: string) => ({ reason }) as ReloadWhy;
const never = () => new Promise<void>(() => {});
const open = (loader: PlayerLoader, id: string) => loader.run('launch', (op) => op.negotiate(async () => pi(id)));

describe('PlayerLoader', () => {
  it('commits the answered session and exposes it as info and sessionId', async () => {
    const { loader } = setup();
    await loader.run('launch', (op) => op.negotiate(async () => pi('a')));
    expect(loader.info()?.sessionId).toBe('a');
    expect(loader.sessionId()).toBe('a');
    expect(loader.busy()).toBe(false);
  });

  it('is busy while an op runs', async () => {
    const { loader } = setup();
    const gate = deferred<void>();
    const run = loader.run('launch', () => gate.promise);
    expect(loader.busy()).toBe(true);
    gate.resolve();
    await run;
    expect(loader.busy()).toBe(false);
  });

  it('rejects an op body once aborted, without waiting for what it awaits', async () => {
    const { loader } = setup();
    const forever = never();
    let seen: unknown;
    const run = loader.run('launch', async (op) => {
      try {
        await op.wait(forever);
      } catch (e) {
        seen = e;
        throw e;
      }
    });
    loader.abort();
    expect(await run).toBeUndefined();
    expect(isLoadSuperseded(seen)).toBe(true);
    expect(loader.busy()).toBe(false);
  });

  it('deletes a session answered after the view was left', async () => {
    const { loader, host } = setup();
    const answer = deferred<PlaybackInfoResponse>();
    const run = loader.run('launch', (op) => op.negotiate(() => answer.promise));
    await flush();
    loader.abort();
    await run;
    answer.resolve(pi('late'));
    await flush();
    expect(host.stopSession).toHaveBeenCalledWith('late');
    expect(loader.info()).toBeNull();
    expect(loader.sessionId()).toBeUndefined();
  });

  /** Leaves 'a' carried: an op that replaced the committed 'z' answered after a newer one started. */
  async function carryA() {
    const t = setup();
    await open(t.loader, 'z');
    const first = deferred<PlaybackInfoResponse>();
    const run1 = t.loader.run('resume', (op) => op.negotiate(() => first.promise));
    await flush();
    void t.loader.run('resume', never);
    first.resolve(pi('a'));
    await run1;
    await flush();
    return t;
  }

  it('deletes a session answered for an outdated op that replaced nothing', async () => {
    const { loader, host } = setup();
    const first = deferred<PlaybackInfoResponse>();
    const run1 = loader.run('launch', (op) => op.negotiate(() => first.promise));
    await flush();
    void loader.run('resume', never);
    first.resolve(pi('a'));
    await run1;
    await flush();
    expect(host.stopSession).toHaveBeenCalledWith('a');
    expect(loader.sessionId()).toBeUndefined();
  });

  it('carries a session answered for an outdated op that replaced one, and the next negotiation replaces it', async () => {
    const { loader, host } = await carryA();
    expect(loader.sessionId()).toBe('a');
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) => op.negotiate(async (replaces) => (calls.push(replaces), pi('b'))));
    expect(calls).toEqual(['a']);
    expect(loader.sessionId()).toBe('b');
    expect(host.stopSession).not.toHaveBeenCalled();
  });

  it('deletes a carried session at abort', async () => {
    const { loader, host } = await carryA();
    loader.abort();
    expect(host.stopSession).toHaveBeenCalledWith('a');
    expect(loader.sessionId()).toBeUndefined();
  });

  it('a negotiation that replaces the carried session does not delete it again', async () => {
    const { loader, host } = await carryA();
    await loader.run('launch', (op) => op.negotiate(async () => pi('b')));
    expect(host.stopSession).not.toHaveBeenCalled();
    expect(loader.sessionId()).toBe('b');
  });

  it('deletes a carried session that an open without replaces leaves behind', async () => {
    const { loader, host } = await carryA();
    await loader.run('launch', (op) => op.negotiate(async () => pi('item'), { replace: false }));
    expect(host.stopSession).toHaveBeenCalledWith('a');
    expect(loader.sessionId()).toBe('item');
  });

  it('replaces the held session in the next open', async () => {
    const { loader } = setup();
    await open(loader, 'old');
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) => op.negotiate(async (replaces) => (calls.push(replaces), pi('new'))));
    expect(calls).toEqual(['old']);
  });

  it('stops the held session first when the server cannot replace inside the open', async () => {
    const { loader, host } = setup(false);
    await open(loader, 'old');
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) => op.negotiate(async (replaces) => (calls.push(replaces), pi('new'))));
    expect(host.stopSession).toHaveBeenCalledWith('old');
    expect(calls).toEqual([undefined]);
  });

  it('opens without replaces when asked, and keeps nothing for the op to delete twice', async () => {
    const { loader, host } = setup();
    await open(loader, 'film');
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) =>
      op.negotiate(async (replaces) => (calls.push(replaces), pi('item')), { replace: false }),
    );
    expect(calls).toEqual([undefined]);
    expect(loader.sessionId()).toBe('item');
    expect(host.stopSession).not.toHaveBeenCalled();
  });

  it('forget drops the committed info and carries its id for the next negotiation to replace', async () => {
    const { loader, host } = setup();
    await open(loader, 'a');
    loader.forget();
    expect(loader.info()).toBeNull();
    expect(loader.sessionId()).toBe('a');
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) => op.negotiate(async (replaces) => (calls.push(replaces), pi('b'))));
    expect(calls).toEqual(['a']);
    expect(loader.sessionId()).toBe('b');
    expect(host.stopSession).not.toHaveBeenCalled();
  });

  it('a second carried session deletes the first', async () => {
    const { loader, host } = setup();
    await open(loader, 'a');
    const ans = { x: deferred<PlaybackInfoResponse>(), y: deferred<PlaybackInfoResponse>() };
    void loader.run('resume', (op) => op.negotiate(() => ans.x.promise));
    await flush();
    void loader.run('resume', (op) => op.negotiate(() => ans.y.promise));
    await flush();
    ans.x.resolve(pi('x'));
    await flush();
    void loader.run('launch', never);
    ans.y.resolve(pi('y'));
    await flush();
    expect(host.stopSession).toHaveBeenCalledTimes(1);
    expect(host.stopSession).toHaveBeenCalledWith('x');
    expect(loader.sessionId()).toBe('y');
  });

  it('stops the replaced session when the open fails', async () => {
    const { loader, host } = setup();
    await open(loader, 'a');
    await expect(
      loader.run('launch', (op) =>
        op.negotiate(async (replaces) => {
          expect(replaces).toBe('a');
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(host.stopSession).toHaveBeenCalledWith('a');
    expect(loader.sessionId()).toBeUndefined();
  });

  it('sessionId is undefined once a stale answer shows the server retired the committed one', async () => {
    const { loader, host } = setup();
    await open(loader, 'a');
    const answer = deferred<PlaybackInfoResponse>();
    void loader.run('resume', (op) => op.negotiate(() => answer.promise));
    await flush();
    loader.supersede();
    answer.resolve(pi('x'));
    await flush();
    expect(host.stopSession).toHaveBeenCalledTimes(1);
    expect(host.stopSession).toHaveBeenCalledWith('x');
    expect(loader.sessionId()).toBeUndefined();
  });

  it('handOff returns the committed session id and leaves nothing to abort or report', async () => {
    const { loader, host } = setup();
    await open(loader, 'a');
    expect(loader.handOff()).toBe('a');
    expect(loader.sessionId()).toBeUndefined();
    loader.abort();
    expect(host.stopSession).not.toHaveBeenCalled();
  });

  it('runs a reload at once when idle', async () => {
    const { loader } = setup();
    const body = vi.fn(async () => {});
    const req = { at: 5, why: why('a') };
    expect(await loader.reload(req, body)).toBe('done');
    expect(body).toHaveBeenCalledWith(expect.anything(), req);
    expect(loader.busy()).toBe(false);
  });

  it('reports a reload whose body throws as failed', async () => {
    const { loader } = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loader.reload({}, async () => { throw new Error('boom'); })).toBe('failed');
    err.mockRestore();
  });

  it('a reload asked while an op runs waits, the newest why wins and at is kept, both resolve with its outcome', async () => {
    const { loader } = setup();
    const gate = deferred<void>();
    const run = loader.run('launch', () => gate.promise);
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const r1 = loader.reload({ at: 10, why: why('a') }, first);
    const r2 = loader.reload({ why: why('b') }, second);
    await flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    gate.resolve();
    await run;
    expect(await Promise.all([r1, r2])).toEqual(['done', 'done']);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(expect.anything(), { at: 10, why: why('b') });
  });

  it.each(['launch', 'switch'] as const)('a %s drops the waiting reload as superseded', async (kind) => {
    const { loader } = setup();
    void loader.run('launch', never);
    const body = vi.fn(async () => {});
    const reload = loader.reload({ at: 1 }, body);
    void loader.run(kind, never);
    expect(await reload).toBe('superseded');
    expect(body).not.toHaveBeenCalled();
  });

  it('recover yields while an op runs', async () => {
    const { loader } = setup();
    void loader.run('launch', never);
    const body = vi.fn(async () => 1);
    expect(await loader.recover(body)).toBeUndefined();
    expect(body).not.toHaveBeenCalled();
  });

  it('recover runs when idle', async () => {
    const { loader } = setup();
    let kind: unknown;
    expect(await loader.recover(async (op) => ((kind = op.kind), 1))).toBe(1);
    expect(kind).toBe('recover');
    expect(loader.busy()).toBe(false);
  });

  it('after a handOff reload and recover yield, and a launch clears that', async () => {
    const { loader } = setup();
    loader.handOff();
    expect(await loader.reload({}, async () => {})).toBe('superseded');
    expect(await loader.recover(async () => 1)).toBeUndefined();
    expect(await loader.run('switch', async () => 1)).toBeUndefined();
    await loader.run('launch', async () => {});
    expect(await loader.reload({}, async () => {})).toBe('done');
    expect(await loader.recover(async () => 1)).toBe(1);
  });

  it('a seek made while a seek-taking op runs sets its start and aim, and is absorbed only before it loaded', async () => {
    const { loader } = setup();
    const gate = deferred<void>();
    let op!: LoadOp;
    const run = loader.run('launch', async (o) => ((op = o), gate.promise), true);
    expect(op.start(5)).toBe(5);
    expect(op.aimed()).toBeUndefined();
    expect(loader.seek(30)).toBe(true);
    expect(op.start(5)).toBe(30);
    op.loaded();
    expect(op.aimed()).toBe(30);
    expect(loader.seek(40)).toBe(false);
    expect(op.aimed()).toBe(30);
    gate.resolve();
    await run;
  });

  it('a seek is not absorbed by an op that does not take seeks, nor when idle', async () => {
    const { loader } = setup();
    expect(loader.seek(1)).toBe(false);
    void loader.run('launch', never);
    expect(loader.seek(1)).toBe(false);
  });

  it('after runs once the op ended, with the loader idle', async () => {
    const { loader } = setup();
    const busy: boolean[] = [];
    await loader.run('launch', async (op) => op.after(async () => void busy.push(loader.busy())));
    await flush();
    expect(busy).toEqual([false]);
  });

  it('after is dropped when a newer op starts', async () => {
    const { loader } = setup();
    const fn = vi.fn(async () => {});
    const gate = deferred<void>();
    const run1 = loader.run('launch', async (op) => (op.after(fn), gate.promise));
    const run2 = loader.run('resume', async () => {});
    gate.resolve();
    await Promise.all([run1, run2]);
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('ended is called once with the kind for a current op, not for a superseded one', async () => {
    const { loader, host } = setup();
    const gate = deferred<void>();
    const run1 = loader.run('launch', () => gate.promise);
    await loader.run('resume', async () => {});
    gate.resolve();
    await run1;
    expect(host.ended.mock.calls).toEqual([['resume']]);
  });

  it('destroys an engine that arrives after the op was outdated, releasing the surface only when nothing runs', async () => {
    const { loader, host } = setup();
    const created = deferred<{ engine: PlaybackEngine }>();
    const engine = { destroy: vi.fn() } as unknown as PlaybackEngine;
    const run = loader.run('launch', (op) => op.engine(created.promise));
    loader.abort();
    await run;
    created.resolve({ engine });
    await flush();
    expect(host.discardEngine).toHaveBeenCalledWith(engine, true);
  });

  it('keeps the surface when a newer op is running as a stale engine arrives', async () => {
    const { loader, host } = setup();
    const created = deferred<{ engine: PlaybackEngine }>();
    const engine = {} as PlaybackEngine;
    void loader.run('launch', (op) => op.engine(created.promise));
    void loader.run('resume', () => new Promise<void>(() => {}));
    created.resolve({ engine });
    await flush();
    expect(host.discardEngine).toHaveBeenCalledWith(engine, false);
  });

  it('unloads an engine whose load was outdated', async () => {
    const { loader } = setup();
    const load = deferred<void>();
    const engine = { load: vi.fn(() => load.promise), unload: vi.fn(async () => {}) } as unknown as PlaybackEngine;
    const run = loader.run('launch', (op) => op.load(engine, 'u', 0));
    loader.abort();
    await run;
    expect(engine.unload).toHaveBeenCalled();
  });

  it('lets a genuine failure of a current op through', async () => {
    const { loader } = setup();
    await expect(loader.run('launch', (op) => op.negotiate(async () => { throw new Error('boom'); }))).rejects.toThrow('boom');
    expect(loader.busy()).toBe(false);
  });
});
