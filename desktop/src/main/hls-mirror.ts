import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ClientRequest } from 'node:http';

// Mirror a transcoded HLS stream to disk so mpv can play it back offline, the
// desktop equivalent of iOS's .movpkg / Android's ExoPlayer cache. Fetches the
// master, the chosen ladder rung, every audio + subtitle rendition and all of
// their segments, rewriting each playlist to reference the local files. The
// segments are pulled in playlist order so the backend's on-demand transcode
// advances linearly (no seek/respawn). Returns the local master.m3u8 path.

function readableOf(res: unknown): Readable {
  return res as unknown as Readable;
}

type RequestFn = (url: string) => Pick<ClientRequest, 'on' | 'end' | 'abort'>;

// Loaded lazily so the module imports under plain node (tests inject `request`).
const netRequest: RequestFn = (url) => {
  const { net } = require('electron') as typeof import('electron');
  return net.request({ url }) as unknown as ReturnType<RequestFn>;
};

function fetchText(
  url: string,
  onRequest: ((abort: () => void) => void) | undefined,
  request: RequestFn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url);
    onRequest?.(() => req.abort());
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

function fetchToFile(
  url: string,
  dest: string,
  onRequest: ((abort: () => void) => void) | undefined,
  request: RequestFn,
): Promise<void> {
  // Write to a temp name and rename, so an interrupted fetch never leaves a
  // partial file that a resume would take for complete.
  const tmp = `${dest}.part`;
  return new Promise<void>((resolve, reject) => {
    const req = request(url);
    onRequest?.(() => req.abort());
    req.on('response', (res) => {
      const body = readableOf(res);
      if ((res.statusCode ?? 0) >= 400) {
        body.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(tmp);
      out.on('error', reject);
      // pipe() doesn't close the dest when the SOURCE errors — destroy it here.
      body.on('error', (e) => {
        out.destroy();
        reject(e);
      });
      body.pipe(out);
      out.on('finish', () => fsp.rename(tmp, dest).then(resolve, reject));
    });
    req.on('error', reject);
    req.end();
  }).catch(async (e) => {
    await fsp.rm(tmp, { force: true });
    throw e;
  });
}

const exists = (p: string): Promise<boolean> =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

const MEDIA_EXTENSIONS = new Set(['.m4s', '.mp4', '.m4a', '.m4v', '.ts', '.aac', '.vtt', '.webvtt', '.srt']);

/** The server's file extension when it is a media one, else none: no other part of its name is reused locally. */
function extensionOf(uri: string): string {
  const ext = path.posix.extname(uri.split('?')[0]).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext) ? ext : '';
}

/** `dir/name`, refusing a name that would land outside `dir` (`pathApi` lets tests use win32 rules). */
export function localPath(dir: string, name: string, pathApi: typeof path = path): string {
  const full = pathApi.resolve(dir, name);
  if (!full.startsWith(pathApi.resolve(dir) + pathApi.sep)) throw new Error(`unsafe local name: ${name}`);
  return full;
}

interface MirrorOpts {
  masterUrl: string;
  quality: string | undefined;
  destDir: string;
  onProgress: (received: number, total: number) => void;
  cancelled: () => boolean;
  /** Receives an abort handle for each in-flight fetch so a cancel is immediate. */
  onRequest?: (abort: () => void) => void;
  /** Request factory; defaults to Electron's net (overridden by tests). */
  request?: RequestFn;
}

export async function mirrorHls(opts: MirrorOpts): Promise<string> {
  const { masterUrl, quality, destDir, onProgress, cancelled, onRequest } = opts;
  const request = opts.request ?? netRequest;
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
  const masterText = await fetchText(masterUrl, onRequest, request);
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
    const text = await fetchText(c.url, onRequest, request);
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
    const segs = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    parsed.push({ child: c, text, init, segs });
  }
  const total = parsed.reduce((n, p) => n + p.segs.length + (p.init ? 1 : 0), 0);
  let received = 0;
  // A file already on disk was completed by an earlier run (writes are atomic).
  const fetchOnce = async (url: string, dest: string): Promise<void> => {
    if (!(await exists(dest))) await fetchToFile(url, dest, onRequest, request);
  };

  for (const p of parsed) {
    if (cancelled()) throw new Error('cancelled');
    const cdir = path.join(destDir, p.child.dir);
    await fsp.mkdir(cdir, { recursive: true });

    // Local names come from the position in the playlist, never from the server's text.
    const initName = p.init ? `init${extensionOf(p.init)}` : undefined;
    const segNames = p.segs.map((seg, i) => `seg-${String(i + 1).padStart(5, '0')}${extensionOf(seg)}`);
    if (p.init && initName) {
      await fetchOnce(resolveFrom(p.child.url, p.init), localPath(cdir, initName));
      onProgress(++received, total);
    }
    for (const [i, seg] of p.segs.entries()) {
      if (cancelled()) throw new Error('cancelled');
      await fetchOnce(resolveFrom(p.child.url, seg), localPath(cdir, segNames[i]));
      onProgress(++received, total);
    }

    // Rewrite the playlist so init + segments point at the local files.
    let n = 0;
    const rewritten = p.text
      .split(/\r?\n/)
      .map((l) => {
        const t = l.trim();
        if (t.startsWith('#EXT-X-MAP:URI=') && initName) {
          return l.replace(/URI="[^"]+"/, `URI="${initName}"`);
        }
        if (t && !t.startsWith('#')) return segNames[n++];
        return l;
      })
      .join('\n');
    await fsp.writeFile(path.join(cdir, 'index.m3u8'), rewritten);
  }

  const masterPath = path.join(destDir, 'master.m3u8');
  await fsp.writeFile(masterPath, masterOut.join('\n'));
  return masterPath;
}
