import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The last cast session, kept in userData so a relaunched app can re-join it. `resume` is the
 *  renderer's opaque player state (ids and track lists, no credentials). */
export interface SessionRecord {
  deviceId: string;
  host: string;
  port: number;
  appId: string;
  sessionId: string;
  resume?: unknown;
}

const FILE = 'cast-session.json';

export function loadRecord(dir: string): SessionRecord | null {
  try {
    const r = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8')) as Partial<SessionRecord>;
    const ok =
      typeof r.deviceId === 'string' && typeof r.host === 'string' && typeof r.port === 'number' &&
      typeof r.appId === 'string' && typeof r.sessionId === 'string' && r.sessionId !== '';
    return ok ? (r as SessionRecord) : null;
  } catch {
    return null;
  }
}

export function saveRecord(dir: string, record: SessionRecord): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, FILE), JSON.stringify(record));
  } catch (e) {
    console.warn('[cast] could not persist the session record', e);
  }
}

export function clearRecord(dir: string): void {
  rmSync(path.join(dir, FILE), { force: true });
}

/** Join only the very session we left: the same app id AND session id. Another sender's launch of
 *  our app (different session id), or no app at all, means the record is stale. */
export function resumeDecision(
  record: SessionRecord,
  receiverStatus: Record<string, unknown> | undefined,
): { transportId: string } | null {
  const apps = (receiverStatus?.['applications'] ?? []) as Record<string, unknown>[];
  const app = apps.find((a) => a['appId'] === record.appId && a['sessionId'] === record.sessionId);
  const transportId = String(app?.['transportId'] ?? '');
  return transportId ? { transportId } : null;
}

/** The persisted player state, only if the receiver still plays that very item (its LOAD
 *  customData ids) and is not idle; otherwise the session is joined without an item. */
export function resumeFromMedia(
  saved: unknown,
  mediaStatus: Record<string, unknown> | undefined,
): unknown {
  if (!mediaStatus || mediaStatus['playerState'] === 'IDLE') return undefined;
  const media = mediaStatus['media'] as { customData?: Record<string, unknown> } | undefined;
  const live = media?.customData;
  const state = saved as { mediaFileId?: number; mediaId?: number } | null | undefined;
  const same =
    typeof state?.mediaFileId === 'number' &&
    live?.['mediaFileId'] === state.mediaFileId &&
    live?.['mediaId'] === state.mediaId;
  return same ? saved : undefined;
}
