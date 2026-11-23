import { app, type WebContents } from 'electron';
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Above this the file is cut down to its last `KEEP_LOG_BYTES` (no rotation). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOG_BYTES = 1024 * 1024;
/** The size is checked on the first write of a run, then every this many writes. */
const CHECK_EVERY = 200;

let writes = 0;

function logPath(): string {
  const dir = app.getPath('logs');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'desktop.log');
}

/** Keeps the last `keep` bytes of `p`, from the start of a line, once it is over `max`. */
export function trimLog(p: string, max: number, keep: number): void {
  const size = statSync(p).size;
  if (size <= max) return;
  const tail = Buffer.alloc(Math.min(keep, size));
  const fd = openSync(p, 'r');
  try {
    readSync(fd, tail, 0, tail.length, size - tail.length);
  } finally {
    closeSync(fd);
  }
  const nl = tail.indexOf(10);
  writeFileSync(p, nl === -1 ? tail : tail.subarray(nl + 1));
}

/** Append one timestamped line to the desktop log file — the only retrievable
 *  diagnostic on a packaged build (no console). */
export function appendLog(line: string): void {
  try {
    const p = logPath();
    if (writes++ % CHECK_EVERY === 0) {
      try {
        trimLog(p, MAX_LOG_BYTES, KEEP_LOG_BYTES);
      } catch {
        /* no existing file yet */
      }
    }
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break the caller.
  }
}

/** Strips a URL's query string (tokens live there) before it's logged. */
export function redactQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?<redacted>`;
}

/** `redactQuery` for every URL embedded in free text (mpv stderr, error JSON). */
export function redactUrls(text: string): string {
  return text.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?<redacted>');
}

/** Echo the page console to stdout in dev only; a packaged build never prints page URLs. */
export function echoRendererConsole(wc: WebContents): void {
  if (!app.isPackaged) wc.on('console-message', (_e, _l, m) => console.log('[renderer]', m));
}
