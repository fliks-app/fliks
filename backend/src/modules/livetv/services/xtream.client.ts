import axios from 'axios';
import { liveTvHeaders, type LiveTvRequestIdentity } from '../livetv-http';

export interface XtreamAccount {
  status: string | null;
  expiresAt: Date | null;
  maxConnections: number;
  activeConnections: number;
  /** e.g. `['m3u8', 'ts']`; empty when the panel doesn't publish the field. */
  allowedOutputFormats: string[];
}

export interface XtreamLiveStream {
  streamId: string;
  name: string;
  number: number | null;
  logo: string | null;
  guideChannelId: string | null;
  categoryName: string | null;
  archiveDays: number;
  /** A ready-made URL the panel supplies for this stream; wins over our own. */
  directSource: string | null;
}

/** `ts` plays widest and is what ffmpeg reads fastest; otherwise take
 *  whatever the panel actually offers rather than guess. */
export function pickOutputFormat(allowed: string[]): string {
  if (!allowed.length) return 'ts';
  return allowed.includes('ts') ? 'ts' : allowed[0];
}

export interface XtreamCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * A panel link pasted from a provider mail is almost always the flat playlist
 * (`get.php`). It carries the credentials and the host, so the richer API is
 * one rewrite away and the admin never has to know the difference.
 */
export function detectXtreamFromUrl(raw: string): XtreamCredentials | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/\/(get|player_api|xmltv)\.php$/i.test(url.pathname)) return null;
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (!username || !password) return null;
  return { baseUrl: `${url.protocol}//${url.host}`, username, password };
}

/**
 * The same panel, recognised from one of its stream URLs rather than from a
 * portal link. A downloaded `get.php` file carries the credentials in every
 * entry (`/live/<user>/<pass>/<id>.ts`), which is what lets an uploaded
 * playlist be upgraded to the live link that actually refreshes.
 */
export function detectXtreamFromStreamUrl(raw: string): XtreamCredentials | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  // `/live/user/pass/123.ts`, and the same shape without the leading segment.
  const offset = ['live', 'movie', 'series'].includes(parts[0]?.toLowerCase() ?? '') ? 1 : 0;
  const [username, password, last] = parts.slice(offset);
  if (!username || !password || !last) return null;
  if (!/^[^/]+\.[A-Za-z0-9]+$/.test(last)) return null;
  return { baseUrl: `${url.protocol}//${url.host}`, username, password };
}

/** The self-refreshing playlist link equivalent to a downloaded copy. */
export function xtreamPlaylistUrl(creds: XtreamCredentials): string {
  return (
    `${creds.baseUrl}/get.php?username=${encodeURIComponent(creds.username)}` +
    `&password=${encodeURIComponent(creds.password)}&type=m3u_plus&output=ts`
  );
}

function toInt(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function toStringOrNull(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length ? s : null;
}

/** Talks to the panel API every provider of this kind exposes. */
export class XtreamClient {
  constructor(
    private readonly creds: XtreamCredentials,
    private readonly userAgent: string | null = null,
    private readonly referer: string | null = null,
  ) {}

  private identity(): LiveTvRequestIdentity {
    return { userAgent: this.userAgent, referer: this.referer };
  }

  private async call<T>(action?: string): Promise<T> {
    const url = new URL(`${this.creds.baseUrl}/player_api.php`);
    url.searchParams.set('username', this.creds.username);
    url.searchParams.set('password', this.creds.password);
    if (action) url.searchParams.set('action', action);
    const res = await axios.get<T>(url.toString(), {
      timeout: REQUEST_TIMEOUT_MS,
      headers: liveTvHeaders(this.identity()),
      // Panels answer 200 with an error body; a redirect to a login page is not data.
      maxRedirects: 2,
    });
    return res.data;
  }

  async account(): Promise<XtreamAccount> {
    const data = await this.call<{ user_info?: Record<string, unknown> }>();
    const info = data?.user_info;
    if (!info || String(info.auth ?? '1') === '0') {
      throw new Error('authentication refused by the provider');
    }
    const exp = toInt(info.exp_date);
    const formats = info.allowed_output_formats;
    return {
      status: toStringOrNull(info.status),
      expiresAt: exp ? new Date(exp * 1000) : null,
      maxConnections: toInt(info.max_connections),
      activeConnections: toInt(info.active_cons),
      allowedOutputFormats: Array.isArray(formats)
        ? formats.map((f) => String(f).toLowerCase())
        : [],
    };
  }

  async liveStreams(): Promise<XtreamLiveStream[]> {
    const [categories, streams] = await Promise.all([
      this.call<Array<Record<string, unknown>>>('get_live_categories'),
      this.call<Array<Record<string, unknown>>>('get_live_streams'),
    ]);
    const categoryNames = new Map<string, string>();
    for (const c of categories ?? []) {
      categoryNames.set(String(c.category_id), String(c.category_name ?? ''));
    }
    return (streams ?? [])
      .filter((s) => s.stream_id != null)
      .map((s) => ({
        streamId: String(s.stream_id),
        name: String(s.name ?? '').trim(),
        number: toInt(s.num) || null,
        logo: toStringOrNull(s.stream_icon),
        guideChannelId: toStringOrNull(s.epg_channel_id),
        categoryName: categoryNames.get(String(s.category_id)) ?? null,
        archiveDays: toInt(s.tv_archive) ? toInt(s.tv_archive_duration) : 0,
        directSource: toStringOrNull(s.direct_source),
      }))
      .filter((s) => s.name.length > 0);
  }

  /** `format` is whatever {@link pickOutputFormat} chose from the account's
   *  `allowed_output_formats`; callers only fall back to this when the stream
   *  itself carried no `direct_source`. */
  streamUrl(streamId: string, format: string): string {
    const { baseUrl, username, password } = this.creds;
    return `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(
      password,
    )}/${streamId}.${format}`;
  }

  guideUrl(): string {
    const { baseUrl, username, password } = this.creds;
    return `${baseUrl}/xmltv.php?username=${encodeURIComponent(
      username,
    )}&password=${encodeURIComponent(password)}`;
  }
}
