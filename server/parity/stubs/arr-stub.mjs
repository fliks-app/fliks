#!/usr/bin/env node
// Radarr / Sonarr / Seerr stub for the importer parity scenarios (docs/spec/importers.md, Vectors/parity).
// Paths are /<service>/<variant>/api/...; fixtures live in server/fixtures/importers/<service>/.
// Variants: ok, 401 and 500 (always), empty (empty lists), slow (20 s status, 3 s elsewhere), plus the per-fixture ones in LISTS.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.ARR_STUB_PORT ?? 4880);
const root = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/importers');
const KEY = 'parity-key';
const load = (service, name) => JSON.parse(readFileSync(join(root, service, `${name}.json`), 'utf8'));
// variant -> list fixture name override per endpoint
const LISTS = {
  radarr: { movie: { ok: 'movie', 'tmdb-zero': 'movie-tmdb-zero', traversal: 'movie-traversal', profile: 'movie-profile' } },
  sonarr: { series: { ok: 'series', v3: 'series-v3', profile: 'series-profile', traversal: 'series-traversal' } },
  seerr: { request: { ok: 'request-page-1', skipped: 'request-page-skipped', claim: 'request-page-claim' } },
};
const hits = [];

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/__hits') return send(res, 200, hits);
  const [, service, variant, ...rest] = url.pathname.split('/');
  const path = '/' + rest.join('/');
  if (!LISTS[service] && !['seerr'].includes(service)) return send(res, 404, {});
  if (variant === '401' || req.headers['x-api-key'] !== KEY) return send(res, 401, { message: 'Unauthorized' });
  if (variant === '500') return send(res, 500, { message: 'boom' });
  if (variant === 'slow') await new Promise((r) => setTimeout(r, path.endsWith('/status') ? 20000 : 3000));
  try {
    const empty = variant === 'empty';
    if (service === 'seerr') {
      if (path === '/api/v1/settings/main') return send(res, 200, load('seerr', 'settings-main'));
      if (path === '/api/v1/request') {
        const page = load('seerr', LISTS.seerr.request[variant] ?? 'request-page-1');
        return send(res, 200, Number(url.searchParams.get('skip')) > 0 || empty ? { pageInfo: { results: 0 }, results: [] } : page);
      }
      const m = path.match(/^\/api\/v1\/(movie|tv)\/(\d+)$/);
      if (m) return send(res, 200, load('seerr', `${m[1]}-${m[2]}`));
    } else {
      if (path === '/api/v3/system/status') return send(res, 200, load(service, 'system-status'));
      if (path === '/api/v3/qualityprofile') return send(res, 200, load(service, 'qualityprofile'));
      if (path === '/api/v3/rootfolder') {
        return send(res, 200, variant === 'not-array' ? { path: '/x' } : variant === 'null-entry' ? [null] : load(service, 'rootfolder'));
      }
      const list = path === '/api/v3/movie' ? 'movie' : path === '/api/v3/series' ? 'series' : null;
      if (list && LISTS[service][list]) {
        if (empty) return send(res, 200, []);
        if (variant === 'not-array') return send(res, 200, { message: 'nope' });
        return send(res, 200, load(service, LISTS[service][list][variant] ?? list));
      }
      if (path === '/api/v3/extrafile') return send(res, 200, load(service, 'extrafile'));
    }
  } catch {
    // unknown fixture below
  }
  send(res, 404, { message: 'not found' });
}).listen(port, '127.0.0.1');
