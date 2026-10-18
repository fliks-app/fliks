// Emby stand-in for parity (no dependencies): `node emby-stub.mjs [port]`, default 4962.
// The first path segment picks the mode: ok, 401, 500, slow (`/Users` waits 3 s), redirect, nousers, big.
// `GET /__hits` lists the Library/Refresh calls, `DELETE /__hits` clears them.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 4962);
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/media-servers/emby');
const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const [info, users, series, items] = ['system-info', 'users', 'series', 'items'].map((f) => load(`${f}.json`));
const hits = [];

const big = (offset, limit) => {
  const all = Array.from({ length: 1100 }, (_, i) => ({
    Id: `big-${i}`, Type: 'Movie', ProviderIds: { Tmdb: String(8000000 + i) }, UserData: { Played: true },
  }));
  return { Items: all.slice(offset, offset + limit), TotalRecordCount: all.length };
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, mode, ...rest] = url.pathname.split('/');
  if (mode === '__hits') {
    if (req.method === 'DELETE') hits.length = 0;
    return send(res, 200, hits);
  }
  const path = '/' + rest.join('/');
  if (mode === '401') return send(res, 401, { error: 'unauthorized' });
  if (mode === '500') return send(res, 500, { error: 'boom' });
  const respond = () => {
    if (mode === 'redirect' && path === '/System/Info') {
      res.writeHead(302, { location: `http://127.0.0.2:${port}/ok/System/Info` });
      return res.end();
    }
    if (path === '/System/Info') return send(res, 200, info);
    if (path === '/Library/Refresh' && req.method === 'POST') {
      hits.push({ mode, token: req.headers['x-emby-token'] ?? null });
      return send(res, 204);
    }
    if (path === '/Users') return mode === 'nousers' ? send(res, 500, {}) : send(res, 200, users);
    const m = path.match(/^\/Users\/([^/]+)\/Items(?:\/(Resume)|\/([^/]+))?$/);
    if (!m) return send(res, 404, {});
    const [, uid, resume, itemId] = m;
    if (itemId) return series[itemId] ? send(res, 200, series[itemId]) : send(res, 404, {});
    const q = url.searchParams;
    const offset = Number(q.get('StartIndex') ?? 0);
    const limit = Number(q.get('Limit') ?? 500);
    if (mode === 'big') {
      if (resume || q.get('IsResumable')) return send(res, 200, { Items: [], TotalRecordCount: 0 });
      return send(res, 200, uid === 'u1' ? big(offset, limit) : { Items: [], TotalRecordCount: 0 });
    }
    const set = items[uid]?.[resume ? 'resume' : q.get('IsPlayed') ? 'played' : 'resumable'] ?? [];
    send(res, 200, { Items: set.slice(offset, offset + limit), TotalRecordCount: set.length });
  };
  if (mode === 'slow' && path === '/Users') return setTimeout(respond, 3000);
  respond();
}).listen(port, '0.0.0.0', () => console.log(`emby stub on ${port}`));
