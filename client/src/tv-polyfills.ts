/** TV browsers lag the bundle's Baseline: Tizen 6.5 and webOS 6 ship
 *  Chromium 76-85, and `BROWSERSLIST` only lowers syntax, never builtins.
 *  Angular core calls `Object.hasOwn` on every input/output binding, so
 *  without this the app dies before the first paint. */

if (!Object.hasOwn) {
  Object.defineProperty(Object, 'hasOwn', {
    value: (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k),
    configurable: true,
    writable: true,
  });
}

for (const proto of [Array.prototype, String.prototype] as { at?: unknown }[]) {
  if (!proto.at) {
    Object.defineProperty(proto, 'at', {
      value: function (this: ArrayLike<unknown>, i: number) {
        const n = Math.trunc(i) || 0;
        return this[n < 0 ? this.length + n : n];
      },
      configurable: true,
      writable: true,
    });
  }
}

if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  Object.defineProperty(crypto, 'randomUUID', {
    value: () =>
      '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (
          Number(c) ^
          (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
        ).toString(16),
      ),
    configurable: true,
    writable: true,
  });
}
