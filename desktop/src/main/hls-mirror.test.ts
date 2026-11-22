import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localPath, mirrorHls } from './hls-mirror.ts';

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
  assert.deepEqual(readdirSync(path.join(destDir, 'video')).sort(), ['index.m3u8', 'init.mp4', 'seg-00001.m4s', 'seg-00002.m4s', 'seg-00003.m4s']);
  assert.deepEqual(calls.at(-1), [4, 4]);
  const files = readdirSync(path.join(destDir, 'video'));
  assert.ok(!files.some((f) => f.endsWith('.part')));
  assert.ok(files.includes('index.m3u8'));
});

test('a server-chosen name never decides where a segment lands', async () => {
  const evil = '..\\..\\..\\Startup\\x.bat';
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/master.m3u8')) res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/v/index.m3u8\n');
    else if (url.startsWith('/v/index.m3u8')) res.end(`#EXTM3U\n#EXTINF:1,\n${evil}\n#EXTINF:1,\ns1.m4s;rm\n`);
    else res.end('data');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  const destDir = mkdtempSync(path.join(tmpdir(), 'hls-'));
  await mirrorHls({
    masterUrl: `http://127.0.0.1:${port}/master.m3u8`,
    quality: undefined,
    destDir,
    request: (u: string) => httpRequest(u),
    cancelled: () => false,
    onProgress: () => {},
  });
  server.close();
  assert.deepEqual(readdirSync(path.join(destDir, 'video')).sort(), ['index.m3u8', 'seg-00001', 'seg-00002']);
});

test('localPath refuses Windows traversal names', () => {
  const dir = 'C:\\Users\\u\\AppData\\Roaming\\Fliks\\downloads\\1\\video';
  assert.equal(localPath(dir, 'seg-00001.m4s', path.win32), `${dir}\\seg-00001.m4s`);
  for (const name of ['..\\..\\x.bat', '..\\x.bat', '.', '', 'C:\\x.bat', '\\\\host\\share\\x']) {
    assert.throws(() => localPath(dir, name, path.win32), /unsafe local name/, name);
  }
});
