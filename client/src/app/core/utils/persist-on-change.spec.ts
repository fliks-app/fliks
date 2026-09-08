import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { persistOnChange } from './persist-on-change';

describe('persistOnChange', () => {
  it('skips the load and persists every later change', () => {
    const form = signal('a');
    const writes: string[] = [];
    TestBed.runInInjectionContext(() =>
      persistOnChange(() => form(), (v) => writes.push(v)),
    );

    TestBed.tick();
    expect(writes).toEqual([]);

    form.set('b');
    TestBed.tick();
    form.set('c');
    TestBed.tick();
    expect(writes).toEqual(['b', 'c']);
  });

  // The write merges the store it writes to; reading it must not become a
  // dependency, or each write would re-trigger the effect forever.
  it('does not re-trigger on the store the write touches', () => {
    const form = signal('a');
    const store = signal('a');
    let writes = 0;
    TestBed.runInInjectionContext(() =>
      persistOnChange(
        () => form(),
        (v) => {
          writes++;
          store.set(store() + v);
        },
      ),
    );

    TestBed.tick();
    form.set('b');
    TestBed.tick();
    expect(writes).toBe(1);
    expect(store()).toBe('ab');
  });
});
