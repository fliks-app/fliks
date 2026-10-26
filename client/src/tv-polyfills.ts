/** TV browsers (Chromium 76-85) lack builtins that `BROWSERSLIST` can't lower; Angular core calls `Object.hasOwn` on every binding,
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
