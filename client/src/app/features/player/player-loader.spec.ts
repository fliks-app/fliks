import { describe, expect, it, vi } from 'vitest';
import { PlayerLoader, isLoadSuperseded, type LoaderHost } from './player-loader';
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
  } satisfies LoaderHost;
  return { host, loader: new PlayerLoader(host) };
}

const flush = () => new Promise<void>((r) => setTimeout(r));

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
    const never = new Promise<void>(() => {});
    let seen: unknown;
    const run = loader.run('launch', async (op) => {
      try {
        await op.wait(never);
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

  it('carries a session answered for an outdated op, and the next negotiation replaces it', async () => {
    const { loader, host } = setup();
    const first = deferred<PlaybackInfoResponse>();
    const run1 = loader.run('launch', (op) => op.negotiate(() => first.promise));
    await flush();
    const gate = deferred<void>();
    const calls: (string | undefined)[] = [];
    const run2 = loader.run('resume', async (op) => {
      await op.wait(gate.promise);
      await op.negotiate(async (replaces) => (calls.push(replaces), pi('b')));
    });
    first.resolve(pi('a'));
    await run1;
    await flush();
    expect(loader.sessionId()).toBe('a');
    gate.resolve();
    await run2;
    expect(calls).toEqual(['a']);
    expect(loader.sessionId()).toBe('b');
    expect(host.stopSession).not.toHaveBeenCalled();
  });

  it('deletes a carried session at abort', async () => {
    const { loader, host } = setup();
    const first = deferred<PlaybackInfoResponse>();
    const run1 = loader.run('launch', (op) => op.negotiate(() => first.promise));
    await flush();
    void loader.run('resume', () => new Promise<void>(() => {}));
    first.resolve(pi('a'));
    await run1;
    await flush();
    loader.abort();
    expect(host.stopSession).toHaveBeenCalledWith('a');
    expect(loader.sessionId()).toBeUndefined();
  });

  /** Leaves 'a' carried: an op answered after a newer one started. */
  async function carryA() {
    const t = setup();
    const first = deferred<PlaybackInfoResponse>();
    const run1 = t.loader.run('launch', (op) => op.negotiate(() => first.promise));
    await flush();
    void t.loader.run('resume', () => new Promise<void>(() => {}));
    first.resolve(pi('a'));
    await run1;
    await flush();
    return t;
  }

  it('adopt drops the carried session the reload retired, without deleting it again', async () => {
    const { loader, host } = await carryA();
    loader.adopt(pi('b'), 'a');
    expect(host.stopSession).not.toHaveBeenCalled();
    expect(loader.sessionId()).toBe('b');
  });

  it('adopt deletes a carried session the adopted answer did not replace', async () => {
    const { loader, host } = await carryA();
    loader.adopt(pi('b'));
    expect(host.stopSession).toHaveBeenCalledWith('a');
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
    loader.adopt(pi('old'));
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) => op.negotiate(async (replaces) => (calls.push(replaces), pi('new'))));
    expect(calls).toEqual(['old']);
  });

  it('stops the held session first when the server cannot replace inside the open', async () => {
    const { loader, host } = setup(false);
    loader.adopt(pi('old'));
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) => op.negotiate(async (replaces) => (calls.push(replaces), pi('new'))));
    expect(host.stopSession).toHaveBeenCalledWith('old');
    expect(calls).toEqual([undefined]);
  });

  it('opens without replaces when asked, and keeps nothing for the op to delete twice', async () => {
    const { loader, host } = setup();
    loader.adopt(pi('film'));
    const calls: (string | undefined)[] = [];
    await loader.run('launch', (op) =>
      op.negotiate(async (replaces) => (calls.push(replaces), pi('item')), { replace: false }),
    );
    expect(calls).toEqual([undefined]);
    expect(loader.sessionId()).toBe('item');
    expect(host.stopSession).not.toHaveBeenCalled();
  });

  it('forget drops the committed answer', () => {
    const { loader } = setup();
    loader.adopt(pi('a'));
    loader.forget();
    expect(loader.info()).toBeNull();
    expect(loader.sessionId()).toBeUndefined();
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
