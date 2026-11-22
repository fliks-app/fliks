/** The TV floor is Chromium 76 (Tizen 6.5); TV browsers lack builtins that `BROWSERSLIST` can't lower; Angular core calls `Object.hasOwn` on every binding,
 *  so without this polyfill the app dies before first paint. */

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

if (typeof globalThis.structuredClone !== 'function') {
  // JSON round trip: enough for the plain rule objects the TV clones.
  globalThis.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
}

export {};
