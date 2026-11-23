import { app, BrowserWindow, net, type ClientRequest, type IncomingMessage } from 'electron';
import { createWriteStream, existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  DOWNLOAD_IPC,
  type DesktopDownloadItem,
  type DesktopDownloadRequest,
  type DesktopDownloadStatus,
} from '../shared/contract';
import { fliksClientHeader } from './client-header';
import { httpUrl, parseDownloadRequest, parseManifest, resolveExt } from './download-parse';
import { mirrorHls } from './hls-mirror';
import { handle, none, str } from './ipc-handle';
import { appendLog, redactUrls } from './log-file';
import { localFileUrl } from './protocol';

// Offline downloads for the desktop client: fetch a media file to disk under
// userData and hand mpv a local file:// URL on playback. Sidecar subtitle files
// are fetched the same way (mpv can only sub-add a real path, not a blob URL).
// The download URL carries the ?token= stream JWT. net.request raises no `certificate-error`:
// a server whose certificate the OS rejects cannot be downloaded from, pinned or not.

const PROGRESS_MIN_INTERVAL_MS = 400;

type Manifest = Record<string, DesktopDownloadItem>;

function baseDir(): string {
  return path.join(app.getPath('userData'), 'downloads');
}
function filesDir(): string {
  return path.join(baseDir(), 'files');
}
function manifestPath(): string {
  return path.join(baseDir(), 'manifest.json');
}
/** Collapse anything that isn't a safe filename char to a single flat segment,
 *  so an id/key can never resolve outside the downloads dir. `.` is excluded
 *  from the allowed set too — otherwise `.`/`..` would pass through and
 *  `path.join(baseDir(), '..')` would escape to userData. */
function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_') || '_';
}

let manifestLoad: Promise<Manifest> | null = null;
/** id → abort: tears down the in-flight single-file request + its write stream. */
const active = new Map<string, () => void>();
interface HlsControl { cancelled: boolean; paused?: boolean; abort?: () => void; done?: Promise<void> }
const hlsActive = new Map<string, HlsControl>();

function logError(what: string, e: unknown): void {
  appendLog(redactUrls(`[download] ${what}: ${(e as Error)?.message ?? e}`));
}

function loadManifest(): Promise<Manifest> {
  manifestLoad ??= readManifest();
  return manifestLoad;
}
async function readManifest(): Promise<Manifest> {
  let text: string;
  try {
    text = await fsp.readFile(manifestPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logError('manifest unreadable', e);
    return {};
  }
  try {
    return parseManifest(text);
  } catch (e) {
    // Keep the bytes: the next save would otherwise replace them with an empty manifest.
    const aside = `${manifestPath()}.corrupt-${Date.now()}`;
    await fsp.rename(manifestPath(), aside).catch(() => {});
    logError(`manifest unparsable, moved to ${path.basename(aside)}`, e);
    return {};
  }
}

let saving: Promise<void> = Promise.resolve();
let tmpSeq = 0;
/** Saves run one after the other, each writing the manifest as it is when its turn comes. */
function saveManifest(): Promise<void> {
  const run = async (): Promise<void> => {
    await fsp.mkdir(baseDir(), { recursive: true });
    // Write-then-rename so a reader can't observe a truncated file.
    const tmp = `${manifestPath()}.${++tmpSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(await loadManifest()));
      await fsp.rename(tmp, manifestPath());
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  };
  saving = saving.then(run, run);
  return saving;
}

function broadcast(status: DesktopDownloadStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(DOWNLOAD_IPC.status, status);
  }
}

function cleanup(tmpPath: string): void {
  fsp.rm(tmpPath, { force: true }).catch(() => {});
}

/** Registers the id synchronously, so a second `start` during the awaits below is a no-op. */
async function start(req: DesktopDownloadRequest): Promise<void> {
  if (active.has(req.id) || hlsActive.has(req.id)) return; // already downloading

  // A .m3u8 source is a transcoded stream — mirror the HLS bundle to disk.
  const hls = /\.m3u8(\?|$)/i.test(req.url);
  const file: FileTask = { stopped: false, request: null, out: null };
  let finish = (): void => {};
  const control: HlsControl = { cancelled: false, done: new Promise<void>((r) => (finish = r)) };
  if (hls) hlsActive.set(req.id, control);
  else active.set(req.id, () => abortFile(file));
  const release = (): void => {
    if (hls) {
      hlsActive.delete(req.id);
      finish();
    } else active.delete(req.id);
  };

  try {
    const done = (await loadManifest())[req.id];
    if (done?.complete && existsSync(done.path)) {
      release();
      broadcast({ id: req.id, state: 'done', item: done });
      return;
    }
    await fsp.mkdir(baseDir(), { recursive: true });
  } catch (e) {
    release();
    logError('start failed', e);
    broadcast({ id: req.id, state: 'error', message: (e as Error).message });
    return;
  }
  if (hls) await startHls(req, control, release);
  else await startFile(req, file);
}

interface FileTask {
  stopped: boolean;
  request: ClientRequest | null;
  out: ReturnType<typeof createWriteStream> | null;
}

/** Abort the request AND destroy the write stream (aborting the net request
 *  doesn't necessarily surface as a body 'error'); the caller owns the .part. */
function abortFile(task: FileTask): void {
  task.stopped = true;
  try {
    task.request?.abort();
  } catch {
    /* already ended */
  }
  task.out?.destroy();
}

async function startFile(req: DesktopDownloadRequest, task: FileTask): Promise<void> {
  const tmpPath = path.join(baseDir(), `${safe(req.id)}.part`);
  // A leftover .part from a pause or crash is resumed with a Range request.
  const offset = await fsp.stat(tmpPath).then((s) => s.size, () => 0);
  if (task.stopped) return;
  const request = net.request({ url: req.url, method: 'GET', headers: fliksClientHeader() });
  task.request = request;
  if (offset > 0) request.setHeader('Range', `bytes=${offset}-`);

  const fail = (message: string, e?: unknown): void => {
    if (task.stopped) return;
    active.delete(req.id);
    task.out?.destroy();
    if (e) logError('transfer failed', e);
    broadcast({ id: req.id, state: 'error', message });
  };

  const onResponse = (res: IncomingMessage): void => {
    // Electron's net IncomingMessage is a Readable at runtime; its types omit
    // the stream methods, so read status/headers off `res` and stream via `body`.
    const body = res as unknown as Readable;
    if (res.statusCode === 416 && offset > 0) {
      // The .part no longer matches the source: restart from scratch.
      active.delete(req.id);
      body.resume();
      cleanup(tmpPath);
      void start(req);
      return;
    }
    if ((res.statusCode ?? 0) >= 400) {
      active.delete(req.id);
      broadcast({ id: req.id, state: 'error', message: `HTTP ${res.statusCode}` });
      body.resume();
      return;
    }
    const headers = res.headers as Record<string, string | string[]>;
    const header = (k: string): string | undefined => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const resumed = res.statusCode === 206 && offset > 0;
    const total = resumed
      ? Number(/\/(\d+)\s*$/.exec(header('content-range') ?? '')?.[1] ?? 0)
      : Number(header('content-length') ?? 0);
    const ext = resolveExt(headers);
    const finalPath = path.join(baseDir(), `${safe(req.id)}${ext}`);
    const w = createWriteStream(tmpPath, { flags: resumed ? 'a' : 'w' });
    task.out = w;
    let received = resumed ? offset : 0;
    let lastEmit = 0;

    w.on('error', (e) => fail(e.message, e));

    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (!w.write(chunk)) body.pause();
      const now = Date.now();
      if (now - lastEmit >= PROGRESS_MIN_INTERVAL_MS) {
        lastEmit = now;
        broadcast({ id: req.id, state: 'progress', received, total });
      }
    });
    w.on('drain', () => body.resume());
    body.on('error', (e: Error) => fail(e.message, e));
    body.on('end', () => {
      w.end(async () => {
        try {
          await fsp.rename(tmpPath, finalPath);
          const item: DesktopDownloadItem = {
            id: req.id,
            filename: req.filename ?? path.basename(finalPath),
            path: finalPath,
            size: received,
            received,
            complete: true,
          };
          (await loadManifest())[req.id] = item;
          await saveManifest();
          active.delete(req.id);
          broadcast({ id: req.id, state: 'done', item });
        } catch (e) {
          fail((e as Error).message, e);
        }
      });
    });
  };

  // A throw in the handler would otherwise leave the id in `active` with no event to the page.
  request.on('response', (res) => {
    try {
      onResponse(res);
    } catch (e) {
      fail((e as Error).message, e);
    }
  });
  request.on('error', (e) => {
    if (task.stopped) return;
    active.delete(req.id);
    logError('request failed', e);
    broadcast({ id: req.id, state: 'error', message: e.message });
  });
  request.end();
}

/** Mirror a transcoded HLS stream to a per-id directory; the manifest points at
 *  the local master.m3u8 so playback loads it via mpv (file://). */
async function startHls(req: DesktopDownloadRequest, control: HlsControl, release: () => void): Promise<void> {
  const destDir = path.join(baseDir(), safe(req.id));
  let lastEmit = 0;
  try {
    if (control.cancelled) throw new Error('cancelled');
    const masterPath = await mirrorHls({
      masterUrl: req.url,
      quality: req.quality,
      destDir,
      cancelled: () => control.cancelled,
      onRequest: (abort) => {
        control.abort = abort;
      },
      onProgress: (received, total) => {
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_MIN_INTERVAL_MS || received === total) {
          lastEmit = now;
          broadcast({ id: req.id, state: 'progress', received, total });
        }
      },
    });
    const item: DesktopDownloadItem = {
      id: req.id,
      filename: req.filename ?? req.id,
      path: masterPath,
      size: 0,
      received: 0,
      complete: true,
    };
    (await loadManifest())[req.id] = item;
    await saveManifest();
    broadcast({ id: req.id, state: 'done', item });
  } catch (e) {
    if (control.paused) {
      broadcast({ id: req.id, state: 'paused' });
    } else if (control.cancelled) {
      await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!control.cancelled) {
      logError('hls mirror failed', e);
      broadcast({ id: req.id, state: 'error', message: (e as Error).message });
    }
  } finally {
    release();
  }
}

/** Stop the transfer, keep the data on disk; `start` again resumes it. */
async function pause(id: string): Promise<void> {
  const hls = hlsActive.get(id);
  if (hls) {
    hls.paused = hls.cancelled = true;
    try {
      hls.abort?.();
    } catch {
      /* request already ended */
    }
    await hls.done;
    return;
  }
  const abort = active.get(id);
  if (!abort) return;
  active.delete(id);
  abort();
  broadcast({ id, state: 'paused' });
}

async function cancel(id: string): Promise<void> {
  const hls = hlsActive.get(id);
  if (hls) {
    hls.cancelled = true;
    hls.paused = false;
    try {
      hls.abort?.();
    } catch {
      /* request already ended */
    }
  }
  const abort = active.get(id);
  active.delete(id);
  abort?.();
  cleanup(path.join(baseDir(), `${safe(id)}.part`));
  // A paused HLS download has no running task to drop its directory.
  if (!(await loadManifest())[id]?.complete) {
    await fsp.rm(path.join(baseDir(), safe(id)), { recursive: true, force: true }).catch(() => {});
  }
}

async function remove(id: string): Promise<void> {
  await cancel(id);
  const m = await loadManifest();
  const item = m[id];
  if (item) {
    await fsp.rm(item.path, { force: true }).catch(() => {});
    delete m[id];
    await saveManifest();
  }
  // An HLS download lives in a per-id directory alongside the manifest entry.
  await fsp.rm(path.join(baseDir(), safe(id)), { recursive: true, force: true }).catch(() => {});
}

async function getLocalUrl(id: string): Promise<string | null> {
  const item = (await loadManifest())[id];
  if (item?.complete && existsSync(item.path)) {
    return pathToFileURL(item.path).toString();
  }
  return null;
}

/** Fetch a small sidecar file (VTT) to disk under `key`. */
async function saveFile(key: string, url: string): Promise<boolean> {
  await fsp.mkdir(filesDir(), { recursive: true });
  const dest = path.join(filesDir(), safe(key));
  return new Promise<boolean>((resolve) => {
    const request = net.request({ url, method: 'GET', headers: fliksClientHeader() });
    request.on('response', (res) => {
      const body = res as unknown as Readable;
      if ((res.statusCode ?? 0) >= 400) {
        body.resume();
        resolve(false);
        return;
      }
      const out = createWriteStream(dest);
      out.on('error', () => resolve(false));
      // pipe() doesn't close the dest when the SOURCE errors — destroy it here.
      body.on('error', () => {
        out.destroy();
        resolve(false);
      });
      body.pipe(out);
      out.on('finish', () => resolve(true));
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

/** The sidecar file saved under `key`, or null. */
export function localFilePath(key: string): string | null {
  const p = path.join(filesDir(), safe(key));
  return existsSync(p) ? p : null;
}

async function fileUrl(key: string): Promise<string | null> {
  return localFilePath(key) ? localFileUrl(key) : null;
}

async function deleteFile(key: string): Promise<void> {
  await fsp.rm(path.join(filesDir(), safe(key)), { force: true }).catch(() => {});
}

async function freeSpace(): Promise<{ freeBytes: number; totalBytes: number }> {
  const dir = baseDir();
  await fsp.mkdir(dir, { recursive: true });
  const st = await fsp.statfs(dir);
  return { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
}

/** Wire the renderer→main download channels. Registered once on app ready. */
export function registerDownloadIpc(): void {
  const id = (a: unknown[]): [string] => [str(a[0], 200)];
  handle(DOWNLOAD_IPC.start, (a): [DesktopDownloadRequest] => [parseDownloadRequest(a[0])], (req) => start(req));
  handle(DOWNLOAD_IPC.pause, id, (i) => pause(i));
  handle(DOWNLOAD_IPC.cancel, id, (i) => cancel(i));
  handle(DOWNLOAD_IPC.remove, id, (i) => remove(i));
  handle(DOWNLOAD_IPC.list, none, async () => Object.values(await loadManifest()));
  handle(DOWNLOAD_IPC.getLocalUrl, id, (i) => getLocalUrl(i));
  handle(DOWNLOAD_IPC.saveFile, (a): [string, string] => [str(a[0], 200), httpUrl(a[1])], (key, url) => saveFile(key, url));
  handle(DOWNLOAD_IPC.fileUrl, id, (key) => fileUrl(key));
  handle(DOWNLOAD_IPC.deleteFile, id, (key) => deleteFile(key));
  handle(DOWNLOAD_IPC.freeSpace, none, () => freeSpace());
}
