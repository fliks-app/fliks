import { net } from 'electron';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

// Mirror a transcoded HLS stream to disk so mpv can play it back offline, the
// desktop equivalent of iOS's .movpkg / Android's ExoPlayer cache. Fetches the
// master, the chosen ladder rung, every audio + subtitle rendition and all of
// their segments, rewriting each playlist to reference the local files. The
// segments are pulled in playlist order so the backend's on-demand transcode
// advances linearly (no seek/respawn). Returns the local master.m3u8 path.

function readableOf(res: Electron.IncomingMessage): Readable {
  return res as unknown as Readable;
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url });
    req.on('response', (res) => {
      const body = readableOf(res);
      if ((res.statusCode ?? 0) >= 400) {
        body.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      body.on('data', (c: Buffer) => chunks.push(c));
      body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      body.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url });
    req.on('response', (res) => {
      const body = readableOf(res);
      if ((res.statusCode ?? 0) >= 400) {
        body.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(dest);
      out.on('error', reject);
      body.on('error', reject);
      body.pipe(out);
      out.on('finish', () => resolve());
    });
    req.on('error', reject);
    req.end();
  });
}

/** Last path component of a URI, query stripped (e.g. `seg-0001.m4s`). */
function basename(uri: string): string {
  return uri.split('?')[0].split('/').pop() || 'seg';
}

interface MirrorOpts {
  masterUrl: string;
  quality: string | undefined;
  destDir: string;
  onProgress: (received: number, total: number) => void;
  cancelled: () => boolean;
}

export async function mirrorHls(opts: MirrorOpts): Promise<string> {
  const { masterUrl, quality, destDir, onProgress, cancelled } = opts;
  const origin = new URL(masterUrl).origin;
  const token = new URL(masterUrl).searchParams.get('token') ?? '';

  // Absolutise a playlist-relative URI and carry the stream token forward.
  const resolveFrom = (base: string, uri: string): string => {
    const abs = /^https?:/i.test(uri)
      ? uri
      : uri.startsWith('/')
        ? origin + uri
        : new URL(uri, base).toString();
    if (!token) return abs;
    const u = new URL(abs);
    if (!u.searchParams.has('token')) u.searchParams.set('token', token);
    return u.toString();
  };

  await fsp.mkdir(destDir, { recursive: true });
  const masterText = await fetchText(masterUrl);
  const mlines = masterText.split(/\r?\n/);

  // Pick one variant: the rung whose URI matches the requested quality, else
  // the first listed. Every audio / subtitle rendition is kept.
  const variants: string[] = [];
  for (let i = 0; i < mlines.length; i++) {
    if (mlines[i].startsWith('#EXT-X-STREAM-INF')) variants.push((mlines[i + 1] ?? '').trim());
  }
  const chosenUri =
    variants.find((u) => quality && u.includes(`/${quality}/`)) ?? variants[0];
  if (!chosenUri) throw new Error('no variant in master playlist');

  const children: { url: string; dir: string }[] = [
    { url: resolveFrom(masterUrl, chosenUri), dir: 'video' },
  ];
  const masterOut: string[] = [];
  let audioN = 0;
  let subN = 0;
  for (let i = 0; i < mlines.length; i++) {
    const line = mlines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const uri = (mlines[i + 1] ?? '').trim();
      i++;
      if (uri === chosenUri) {
        masterOut.push(line, 'video/index.m3u8');
      }
      continue; // drop non-chosen rungs
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const uriM = /URI="([^"]+)"/.exec(line);
      const isAudio = /TYPE=AUDIO/.test(line);
      const isSubs = /TYPE=SUBTITLES/.test(line);
      if (uriM && (isAudio || isSubs)) {
        const dir = isAudio ? `audio${audioN++}` : `subs${subN++}`;
        children.push({ url: resolveFrom(masterUrl, uriM[1]), dir });
        masterOut.push(line.replace(/URI="[^"]+"/, `URI="${dir}/index.m3u8"`));
      } else {
        masterOut.push(line);
      }
      continue;
    }
    masterOut.push(line);
  }

  // Fetch every child playlist first (cheap) so the total segment count — hence
  // the progress denominator — is known before pulling segments.
  const parsed = [];
  for (const c of children) {
    const text = await fetchText(c.url);
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
    const segs = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    parsed.push({ child: c, text, init, segs });
  }
  const total = parsed.reduce((n, p) => n + p.segs.length + (p.init ? 1 : 0), 0);
  let received = 0;

  for (const p of parsed) {
    if (cancelled()) throw new Error('cancelled');
    const cdir = path.join(destDir, p.child.dir);
    await fsp.mkdir(cdir, { recursive: true });

    let initName: string | undefined;
    if (p.init) {
      initName = basename(p.init);
      await fetchToFile(resolveFrom(p.child.url, p.init), path.join(cdir, initName));
      onProgress(++received, total);
    }
    for (const seg of p.segs) {
      if (cancelled()) throw new Error('cancelled');
      await fetchToFile(resolveFrom(p.child.url, seg), path.join(cdir, basename(seg)));
      onProgress(++received, total);
    }

    // Rewrite the playlist so init + segments point at the local basenames.
    const rewritten = p.text
      .split(/\r?\n/)
      .map((l) => {
        const t = l.trim();
        if (t.startsWith('#EXT-X-MAP:URI=') && initName) {
          return l.replace(/URI="[^"]+"/, `URI="${initName}"`);
        }
        if (t && !t.startsWith('#')) return basename(t);
        return l;
      })
      .join('\n');
    await fsp.writeFile(path.join(cdir, 'index.m3u8'), rewritten);
  }

  const masterPath = path.join(destDir, 'master.m3u8');
  await fsp.writeFile(masterPath, masterOut.join('\n'));
  return masterPath;
}
