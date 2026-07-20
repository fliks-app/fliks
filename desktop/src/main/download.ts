import { app, BrowserWindow, ipcMain, net } from 'electron';
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
import { mirrorHls } from './hls-mirror';

// Offline downloads for the desktop client: fetch a media file to disk under
// userData and hand mpv a local file:// URL on playback. Sidecar subtitle files
// are fetched the same way (mpv can only sub-add a real path, not a blob URL).
// The download URL already carries the ?token= stream JWT, and net.request goes
// out on the default session (self-signed certs accepted app-wide).

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

let manifest: Manifest | null = null;
/** id → abort: tears down the in-flight single-file request + its write stream. */
const active = new Map<string, () => void>();
const hlsActive = new Map<string, { cancelled: boolean; abort?: () => void }>();

async function loadManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath(), 'utf8')) as Manifest;
  } catch {
    manifest = {};
  }
  return manifest;
}
async function saveManifest(): Promise<void> {
  await fsp.mkdir(baseDir(), { recursive: true });
  // Write-then-rename so a concurrent finish can't observe a truncated file.
  const tmp = `${manifestPath()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest ?? {}));
  await fsp.rename(tmp, manifestPath());
}

function broadcast(status: DesktopDownloadStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(DOWNLOAD_IPC.status, status);
  }
}

/** Extension for the on-disk file, from Content-Disposition then Content-Type. */
function resolveExt(headers: Record<string, string | string[]>): string {
  const cd = headers['content-disposition'];
  const disp = Array.isArray(cd) ? cd[0] : cd;
  if (disp) {
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp);
    const ext = m ? path.extname(decodeURIComponent(m[1].trim())) : '';
    if (ext) return ext;
  }
  const ct = headers['content-type'];
  const type = (Array.isArray(ct) ? ct[0] : ct)?.split(';')[0].trim();
  const map: Record<string, string> = {
    'video/x-matroska': '.mkv',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/mp2t': '.ts',
    'video/webm': '.webm',
  };
  return (type && map[type]) || '.bin';
}

function cleanup(tmpPath: string): void {
  fsp.rm(tmpPath, { force: true }).catch(() => {});
}

async function start(req: DesktopDownloadRequest): Promise<void> {
  const m = await loadManifest();
  const done = m[req.id];
  if (done?.complete && existsSync(done.path)) {
    broadcast({ id: req.id, state: 'done', item: done });
    return;
  }
  if (active.has(req.id) || hlsActive.has(req.id)) return; // already downloading

  await fsp.mkdir(baseDir(), { recursive: true });

  // A .m3u8 source is a transcoded stream — mirror the HLS bundle to disk.
  if (/\.m3u8(\?|$)/i.test(req.url)) {
    await startHls(req);
    return;
  }

  const tmpPath = path.join(baseDir(), `${safe(req.id)}.part`);
  const request = net.request({ url: req.url, method: 'GET' });
  let out: ReturnType<typeof createWriteStream> | null = null;
  // Cancel = abort the request AND destroy the write stream (aborting the net
  // request doesn't necessarily surface as a body 'error'), then drop the .part.
  active.set(req.id, () => {
    try {
      request.abort();
    } catch {
      /* already ended */
    }
    out?.destroy();
    cleanup(tmpPath);
  });

  request.on('response', (res) => {
    // Electron's net IncomingMessage is a Readable at runtime; its types omit
    // the stream methods, so read status/headers off `res` and stream via `body`.
    const body = res as unknown as Readable;
    if ((res.statusCode ?? 0) >= 400) {
      active.delete(req.id);
      broadcast({ id: req.id, state: 'error', message: `HTTP ${res.statusCode}` });
      body.resume();
      return;
    }
    const headers = res.headers as Record<string, string | string[]>;
    const total = Number((Array.isArray(headers['content-length']) ? headers['content-length'][0] : headers['content-length']) ?? 0);
    const ext = resolveExt(headers);
    const finalPath = path.join(baseDir(), `${safe(req.id)}${ext}`);
    const w = createWriteStream(tmpPath);
    out = w;
    let received = 0;
    let lastEmit = 0;

    const fail = (message: string): void => {
      active.delete(req.id);
      w.destroy();
      cleanup(tmpPath);
      broadcast({ id: req.id, state: 'error', message });
    };
    w.on('error', (e) => fail(e.message));

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
    body.on('error', (e: Error) => fail(e.message));
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
          fail((e as Error).message);
        }
      });
    });
  });
  request.on('error', (e) => {
    active.delete(req.id);
    cleanup(tmpPath);
    broadcast({ id: req.id, state: 'error', message: e.message });
  });
  request.end();
}

/** Mirror a transcoded HLS stream to a per-id directory; the manifest points at
 *  the local master.m3u8 so playback loads it via mpv (file://). */
async function startHls(req: DesktopDownloadRequest): Promise<void> {
  const destDir = path.join(baseDir(), safe(req.id));
  await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
  const control: { cancelled: boolean; abort?: () => void } = { cancelled: false };
  hlsActive.set(req.id, control);
  let lastEmit = 0;
  try {
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
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => {});
    if (!control.cancelled) {
      broadcast({ id: req.id, state: 'error', message: (e as Error).message });
    }
  } finally {
    hlsActive.delete(req.id);
  }
}

async function cancel(id: string): Promise<void> {
  const hls = hlsActive.get(id);
  if (hls) {
    hls.cancelled = true;
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
    const request = net.request({ url, method: 'GET' });
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

async function fileUrl(key: string): Promise<string | null> {
  const p = path.join(filesDir(), safe(key));
  return existsSync(p) ? pathToFileURL(p).toString() : null;
}

async function deleteFile(key: string): Promise<void> {
  await fsp.rm(path.join(filesDir(), safe(key)), { force: true }).catch(() => {});
}

/** Wire the renderer→main download channels. Registered once on app ready. */
export function registerDownloadIpc(): void {
  ipcMain.handle(DOWNLOAD_IPC.start, (_e, req: DesktopDownloadRequest) => start(req));
  ipcMain.handle(DOWNLOAD_IPC.cancel, (_e, id: string) => cancel(id));
  ipcMain.handle(DOWNLOAD_IPC.remove, (_e, id: string) => remove(id));
  ipcMain.handle(DOWNLOAD_IPC.list, async () => Object.values(await loadManifest()));
  ipcMain.handle(DOWNLOAD_IPC.getLocalUrl, (_e, id: string) => getLocalUrl(id));
  ipcMain.handle(DOWNLOAD_IPC.saveFile, (_e, key: string, url: string) => saveFile(key, url));
  ipcMain.handle(DOWNLOAD_IPC.fileUrl, (_e, key: string) => fileUrl(key));
  ipcMain.handle(DOWNLOAD_IPC.deleteFile, (_e, key: string) => deleteFile(key));
}
