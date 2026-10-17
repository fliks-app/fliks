// Preload for the recording Nest: sends TMDB, TVDB and TMDB image calls to the loopback stub, product code untouched.
// NODE_OPTIONS="--require $PWD/server/parity/external/nest-external-mock.cjs" from backend/ (axios resolves from there).
const path = require('node:path');
const axios = require(require.resolve('axios', { paths: [process.cwd(), path.join(process.cwd(), 'backend')] }));

const stub = (process.env.PARITY_STUB || 'http://127.0.0.1:4964').replace(/\/$/, '');
const routes = [
  ['https://api.themoviedb.org/3', `${stub}/tmdb/3`],
  ['https://api4.thetvdb.com/v4', `${stub}/tvdb/v4`],
  ['https://image.tmdb.org/t/p', `${stub}/img/t/p`],
];
const real = axios.getAdapter(axios.defaults.adapter);

axios.defaults.adapter = (config) => {
  const rel = config.url && !/^https?:/i.test(config.url);
  const full = rel && config.baseURL ? `${config.baseURL.replace(/\/$/, '')}/${config.url.replace(/^\//, '')}` : config.url;
  const hit = routes.find(([from]) => full?.startsWith(from));
  if (hit) {
    config.baseURL = undefined;
    config.url = hit[1] + full.slice(hit[0].length);
  }
  return real(config);
};
