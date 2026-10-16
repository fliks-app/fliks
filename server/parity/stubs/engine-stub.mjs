// Stub engine for the markers scenarios: node engine-stub.mjs [port=4881]; no dependencies.
// Fingerprint jobs end at once, /v1/intro-detect answers one fixed segment per episode.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4881);
// Files of these ids answer /v1/intro-detect after a delay, so a second detect call finds the season running.
const SLOW_FILES = new Set([22, 23]);
const SLOW_MS = 1500;
const jobs = new Map();
let seq = 0;

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const read = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });

const segment = (kind, e) =>
  kind === 'intro'
    ? { mediaFileId: e.mediaFileId, startSeconds: 10, endSeconds: 40, confidence: 0.9, source: 'pairwise' }
    : {
        mediaFileId: e.mediaFileId,
        startSeconds: Math.floor(e.durationSeconds * 80) / 100,
        endSeconds: Math.floor(e.durationSeconds * 95) / 100,
        confidence: 0.8,
        source: 'reference',
      };

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const key = `${req.method} ${pathname}`;
  if (key === 'GET /v1/hello')
    return send(res, 200, {
      engineVersion: '0.3.2',
      protocolVersion: 1,
      features: ['probe', 'capabilities', 'intro-detect'],
      instanceId: 'parity-stub',
    });
  if (key === 'GET /v1/config') return send(res, 200, { revision: 1 });
  if (key === 'PUT /v1/config') return send(res, 200, {});
  if (key === 'POST /v1/jobs') {
    const body = await read(req);
    const jobId = `job-${++seq}`;
    jobs.set(jobId, body);
    return send(res, 200, { jobId });
  }
  const job = pathname.match(/^\/v1\/jobs\/(.+)$/);
  if (req.method === 'GET' && job) {
    const body = jobs.get(job[1]);
    if (!body) return send(res, 404);
    const id = body.media.mediaFileId;
    return send(res, 200, {
      jobId: job[1],
      kind: body.kind.type,
      mediaFileId: id,
      priority: body.priority ?? 'normal',
      state: 'done',
      pct: 100,
      createdMs: 1,
      result: {
        type: 'Fingerprint',
        fingerprint: { hashes: [id, id + 1, id + 2], durationSeconds: 10, baseOffsetSec: body.kind.window?.type === 'head' ? 0 : 5 },
      },
    });
  }
  if (key === 'POST /v1/intro-detect') {
    const body = await read(req);
    if (body.episodes.some((e) => SLOW_FILES.has(e.mediaFileId))) await new Promise((r) => setTimeout(r, SLOW_MS));
    return send(res, 200, { results: body.episodes.map((e) => segment(body.kind, e)) });
  }
  send(res, 404);
}).listen(port, '127.0.0.1', () => console.log(`engine stub on ${port}`));
