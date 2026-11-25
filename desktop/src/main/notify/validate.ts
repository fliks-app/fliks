import type { DesktopNotification, DesktopNotificationAction, DesktopNotifyLabels, DesktopNotifyPrefs } from '../../shared/contract.ts';

const MAX_TEXT = 1000;
const MAX_ACTIONS = 2;

function text(v: unknown, max = MAX_TEXT, optional = false): string {
  if (v === undefined && optional) return '';
  if (typeof v !== 'string' || v.length > max) throw new Error('invalid notification');
  return v;
}

/** The server origin the notification belongs to; http(s) only. */
export function parseServerUrl(v: unknown): URL {
  const u = new URL(text(v, 2048));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid server url');
  return u;
}

/** `v` resolved against the server, refused when it leaves that origin. Returns it as given. */
export function sameOrigin(v: unknown, server: URL): string {
  const s = text(v, 2048);
  if (new URL(s, server).origin !== server.origin) throw new Error('foreign url');
  return s;
}

function action(a: unknown, server: URL): DesktopNotificationAction {
  const o = a as Partial<DesktopNotificationAction>;
  if (o?.kind !== 'open' && o?.kind !== 'call') throw new Error('invalid action');
  return {
    id: text(o.id, 200),
    title: text(o.title, 200),
    kind: o.kind,
    ...(o.url !== undefined ? { url: sameOrigin(o.url, server) } : {}),
    ...(o.token !== undefined ? { token: text(o.token, 4096) } : {}),
  };
}

/** Rebuilds the renderer's payload field by field, so nothing unvalidated reaches the OS. */
export function parseNotification(v: unknown): DesktopNotification {
  const n = v as Partial<DesktopNotification>;
  const server = parseServerUrl(n?.serverUrl);
  if (!Number.isSafeInteger(n.user)) throw new Error('invalid user');
  if (!Array.isArray(n.actions)) throw new Error('invalid actions');
  return {
    id: text(n.id, 200),
    title: text(n.title, 200),
    body: text(n.body),
    ...(n.image ? { image: sameOrigin(n.image, server) } : {}),
    ...(n.tag ? { tag: text(n.tag, 200) } : {}),
    url: sameOrigin(n.url, server),
    serverUrl: server.href,
    user: n.user as number,
    actions: n.actions.slice(0, MAX_ACTIONS).map((a) => action(a, server)),
  };
}

export function parseBadge(v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('invalid badge');
  return Math.min(v as number, 9999);
}

export function parsePrefsPatch(v: unknown): Partial<DesktopNotifyPrefs> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Partial<DesktopNotifyPrefs> = {};
  for (const k of ['notifications', 'background', 'startAtLogin', 'quitOnClose'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') throw new Error('invalid prefs');
    out[k] = o[k];
  }
  return out;
}

export function parseLabels(v: unknown): DesktopNotifyLabels {
  const o = v as Partial<DesktopNotifyLabels>;
  return { open: text(o?.open, 100), quit: text(o?.quit, 100), notifications: text(o?.notifications, 100) };
}
