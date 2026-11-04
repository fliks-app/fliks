import { keyGate, readerKeyAction, readerKeyBindings } from './reader-keys';

const key = (keyCode: number, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', init);
  Object.defineProperty(e, 'keyCode', { value: keyCode });
  return e;
};

describe('readerKeyAction', () => {
  it.each([
    [37, {}, 'left'],
    [39, {}, 'right'],
    [34, {}, 'next'],
    [32, {}, 'next'],
    [33, {}, 'prev'],
    [32, { shiftKey: true }, 'prev'],
    [36, {}, 'start'],
    [35, {}, 'end'],
    [84, {}, 'toc'],
    [83, {}, 'settings'],
    [78, {}, 'notes'],
    [70, {}, 'search'],
    [66, {}, 'bookmark'],
    [13, {}, 'chrome'],
    [27, {}, 'close'],
  ] as const)('maps keyCode %i %j to %s', (code, init, action) => {
    expect(readerKeyAction(key(code, init))).toBe(action);
  });

  it('leaves browser shortcuts and other keys alone', () => {
    expect(readerKeyAction(key(37, { altKey: true }))).toBeNull();
    expect(readerKeyAction(key(39, { metaKey: true }))).toBeNull();
    expect(readerKeyAction(key(65))).toBeNull();
  });

  it('leaves Enter and Space to a focused control and letters and arrows to text fields', () => {
    const combos = readerKeyBindings().flatMap((b) => b.keyCombos);
    const of = (code: number) => combos.filter((c) => c.keyCode === code);
    for (const c of [...of(13), ...of(32)]) expect(c.suppressOnInteractiveElement).toBe(true);
    for (const c of combos.filter((x) => ![13, 32].includes(x.keyCode))) {
      expect(c.suppressOnInteractiveElement).toEqual(['input', 'textarea', 'select']);
    }
  });

  it('gates only the arrows', () => {
    const gate = keyGate(true);
    const combos = readerKeyBindings(gate).flatMap((b) => b.keyCombos);
    expect(combos.filter((c) => c.condition).map((c) => c.keyCode)).toEqual([37, 39]);
  });
});

describe('keyGate', () => {
  it('fires at once with the current value, then on each change, until unsubscribed', () => {
    const gate = keyGate(true);
    const seen: boolean[] = [];
    const off = gate.subscribe((v) => seen.push(v));
    gate.set(false);
    off();
    gate.set(true);
    expect(seen).toEqual([true, false]);
  });
});
