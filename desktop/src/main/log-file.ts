import { app } from 'electron';
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

/** Above this, the file is truncated once at startup (no rotation). */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let truncated = false;

function logPath(): string {
  const dir = app.getPath('logs');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'desktop.log');
}

/** Append one timestamped line to the desktop log file — the only retrievable
 *  diagnostic on a packaged build (no console). */
export function appendLog(line: string): void {
  try {
    const p = logPath();
    if (!truncated) {
      truncated = true;
      try {
        if (statSync(p).size > MAX_LOG_BYTES) truncateSync(p, 0);
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
