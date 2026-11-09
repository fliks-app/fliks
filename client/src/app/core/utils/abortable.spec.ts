import { describe, expect, it } from 'vitest';
import { Subject } from 'rxjs';
import { abortable, isAbort } from './abortable';

describe('abortable', () => {
  it('resolves with the first value', async () => {
    const s = new Subject<number>();
    const p = abortable(s);
    s.next(4);
    expect(await p).toBe(4);
  });

  it('unsubscribes and rejects with an abort when the signal fires', async () => {
    const s = new Subject<number>();
    const ctl = new AbortController();
    const p = abortable(s, ctl.signal);
    expect(s.observed).toBe(true);
    ctl.abort();
    await expect(p).rejects.toSatisfy(isAbort);
    expect(s.observed).toBe(false);
  });

  it('rejects at once on a signal already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(abortable(new Subject<number>(), ctl.signal)).rejects.toSatisfy(isAbort);
  });
});
