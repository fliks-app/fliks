// Preload for the recording Nest: sends the OpenSubtitles and Subdl calls to the loopback stub, product code untouched.
// NODE_OPTIONS="--require $PWD/server/parity/external/nest-subtitle-mock.cjs" (global fetch, no dependency).
const stub = (process.env.PARITY_STUB || 'http://127.0.0.1:4890').replace(/\/$/, '');
const routes = [
  ['https://api.opensubtitles.com/api/v1', `${stub}/opensubtitles/api/v1`],
  ['https://api.subdl.com/api/v1/subtitles', `${stub}/subdl/api/v1/subtitles`],
  ['https://dl.subdl.com', stub],
];
const real = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const hit = routes.find(([from]) => url.startsWith(from));
  return real(hit ? hit[1] + url.slice(hit[0].length) : input, init);
};
