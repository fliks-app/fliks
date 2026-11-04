import { readerKeyAction } from './reader-keys';

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
});
