import { normalizeChannelName } from './channel-name';

export interface M3uEntry {
  /** Stable per source: what a refresh matches an existing stream row on. */
  externalId: string;
  name: string;
  url: string;
  logo: string | null;
  groupName: string | null;
  tvgId: string | null;
  number: number | null;
  shiftMinutes: number;
  /** From `#EXTVLCOPT:http-user-agent=` or a KODIPROP stream_headers entry. */
  userAgent: string | null;
  /** From `#EXTVLCOPT:http-referrer=` or a KODIPROP stream_headers entry. */
  referer: string | null;
  /** Every raw attribute, so a later feature reads one without a parser change. */
  attrs: Record<string, string>;
}

export interface M3uPlaylist {
  /** `x-tvg-url` / `url-tvg` from the header, first entry: the guide the provider suggests. */
  guideUrl: string | null;
  /** Same attribute, kept whole: some providers publish more than one guide, comma separated. */
  guideUrls: string[];
  /** `max-conn` header attribute, the panel's own connection cap for a plain playlist. */
  maxConnections: number | null;
  /** `billed-till` header attribute, whichever shape the provider used. */
  expiresAt: Date | null;
  entries: M3uEntry[];
}

const ATTR = /([A-Za-z0-9_-]+)="([^"]*)"/g;

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(ATTR)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function intOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** `tvg-shift` is in hours, fractional hours included ("-0.5"). */
function shiftMinutes(raw: string | undefined): number {
  if (!raw) return 0;
  const hours = Number.parseFloat(raw);
  return Number.isFinite(hours) ? Math.round(hours * 60) : 0;
}

function splitGuideUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}

/** `billed-till` shows up as a unix timestamp or as a plain date string
 *  depending on the provider; neither form throws on the other's input. */
function parseDateAttr(raw: string | undefined): Date | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    // A value this small is a day-count or a version, not an epoch second.
    return seconds > 1_000_000_000 ? new Date(seconds * 1000) : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `inputstream.adaptive.stream_headers` is a query-string-shaped blob:
 *  `User-Agent=...&Referer=...`, values percent-encoded. */
function parseStreamHeaders(raw: string): { userAgent: string | null; referer: string | null } {
  let userAgent: string | null = null;
  let referer: string | null = null;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = safeDecode(part.slice(eq + 1).trim());
    if (!value) continue;
    if (key === 'user-agent') userAgent = value;
    else if (key === 'referer' || key === 'referrer') referer = value;
  }
  return { userAgent, referer };
}

/** Last path segments that name a manifest rather than a channel. Every HLS
 *  provider uses them, so they identify nothing and collide across entries. */
const GENERIC_SEGMENTS = new Set([
  'index',
  'master',
  'playlist',
  'live',
  'stream',
  'chunklist',
  'variant',
  'manifest',
  'tracks-v1a1',
  'video',
]);

/** A provider's own path convention for on-demand content: films and series
 *  episodes, never a channel. Every other segment is assumed live. */
const ON_DEMAND_PATH = /\/(movie|series)\//i;

/** Whether an entry's URL names on-demand content rather than a live channel. */
export function isOnDemandUrl(url: string): boolean {
  return ON_DEMAND_PATH.test(url.split('?')[0]);
}

/**
 * Identity of one playable entry within a source. Never `tvg-id`: that names
 * the guide, and a provider deliberately gives the HD, FHD and SD feeds of a
 * channel the same one so they share programme data. Keying on it collapses
 * every quality variant and every backup into a single stream, which is the
 * opposite of what the failover model needs.
 *
 * The panel's stream id, last in the URL, is the stable choice; the full URL
 * is the fallback, and a host change re-keys those entries rather than
 * silently merging unrelated channels.
 */
export function deriveExternalId(
  attrs: Record<string, string>,
  url: string,
  name: string,
): string {
  const path = url.split('?')[0];
  const last = path.slice(path.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '');
  if (last && !GENERIC_SEGMENTS.has(last.toLowerCase()) && /^[A-Za-z0-9_.-]+$/.test(last)) {
    return last;
  }
  return url || normalizeChannelName(name);
}

/**
 * Parses an extended M3U playlist. Unknown directives are skipped rather than
 * failing the import: provider playlists carry player-specific lines that
 * nothing here needs, and one of them must never cost a whole lineup.
 */
export function parseM3u(text: string): M3uPlaylist {
  const lines = text.split(/\r?\n/);
  const entries: M3uEntry[] = [];
  let guideUrls: string[] = [];
  let maxConnections: number | null = null;
  let expiresAt: Date | null = null;
  let pending: {
    attrs: Record<string, string>;
    name: string;
    userAgent: string | null;
    referer: string | null;
  } | null = null;
  let pendingGroup: string | null = null;
  const seen = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttrs(line);
      guideUrls = splitGuideUrls(attrs['x-tvg-url'] || attrs['url-tvg']);
      maxConnections = intOrNull(attrs['max-conn']);
      expiresAt = parseDateAttr(attrs['billed-till']);
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const comma = line.indexOf(',');
      pending = {
        attrs: parseAttrs(line),
        name: comma >= 0 ? line.slice(comma + 1).trim() : '',
        userAgent: null,
        referer: null,
      };
      pendingGroup = null;
      continue;
    }
    if (line.startsWith('#EXTGRP')) {
      pendingGroup = line.slice(line.indexOf(':') + 1).trim() || null;
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:') && pending) {
      const rest = line.slice('#EXTVLCOPT:'.length);
      const eq = rest.indexOf('=');
      if (eq > 0) {
        const key = rest.slice(0, eq).trim().toLowerCase();
        const value = rest.slice(eq + 1).trim();
        if (key === 'http-user-agent' && value) pending.userAgent = value;
        else if ((key === 'http-referrer' || key === 'http-referer') && value) {
          pending.referer = value;
        }
      }
      continue;
    }
    if (line.startsWith('#KODIPROP:') && pending) {
      const rest = line.slice('#KODIPROP:'.length);
      const eq = rest.indexOf('=');
      if (eq > 0 && rest.slice(0, eq).trim().toLowerCase() === 'inputstream.adaptive.stream_headers') {
        const headers = parseStreamHeaders(rest.slice(eq + 1).trim());
        if (headers.userAgent) pending.userAgent = headers.userAgent;
        if (headers.referer) pending.referer = headers.referer;
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending) continue;

    const { attrs, name, userAgent, referer } = pending;
    pending = null;
    const displayName = name || attrs['tvg-name'] || '';
    if (!displayName) continue;

    const externalId = deriveExternalId(attrs, line, displayName);
    // A playlist that repeats an id would make the upsert fight itself.
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    entries.push({
      externalId,
      name: displayName,
      url: line,
      logo: attrs['tvg-logo'] || null,
      groupName: attrs['group-title'] || pendingGroup,
      tvgId: attrs['tvg-id'] || null,
      number: intOrNull(attrs['tvg-chno'] ?? attrs['channel-number']),
      shiftMinutes: shiftMinutes(attrs['tvg-shift']),
      userAgent,
      referer,
      attrs,
    });
    pendingGroup = null;
  }

  return {
    guideUrl: guideUrls[0] ?? null,
    guideUrls,
    maxConnections,
    expiresAt,
    entries,
  };
}
