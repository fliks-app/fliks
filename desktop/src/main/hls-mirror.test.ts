import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mirrorHls } from './hls-mirror.ts';

test('mirrorHls resumes without refetching completed segments', async () => {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url.startsWith('/master.m3u8')) {
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/v/index.m3u8\n');
    } else if (url.startsWith('/v/index.m3u8')) {
      res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\ns0.m4s\n#EXTINF:1,\ns1.m4s\n#EXTINF:1,\ns2.m4s\n');
    } else res.end('data');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const masterUrl = `http://127.0.0.1:${port}/master.m3u8`;
  const destDir = mkdtempSync(path.join(tmpdir(), 'hls-'));
  const request = (u: string) => httpRequest(u);

  let seen = 0;
  const calls: [number, number][] = [];
  await assert.rejects(
    mirrorHls({
      masterUrl,
      quality: undefined,
      destDir,
      request,
      cancelled: () => seen >= 2,
      onProgress: (r, t) => {
        seen = r;
        calls.push([r, t]);
      },
    }),
    /cancelled/,
  );
  await mirrorHls({
    masterUrl,
    quality: undefined,
    destDir,
    request,
    cancelled: () => false,
    onProgress: (r, t) => calls.push([r, t]),
  });
  server.close();

  for (const f of ['init.mp4', 's0.m4s', 's1.m4s', 's2.m4s']) assert.equal(hits.get(`/v/${f}`), 1, f);
  assert.deepEqual(calls.at(-1), [4, 4]);
  const files = readdirSync(path.join(destDir, 'video'));
  assert.ok(!files.some((f) => f.endsWith('.part')));
  assert.ok(files.includes('index.m3u8'));
});
