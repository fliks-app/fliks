import axios, { type AxiosRequestConfig, type RawAxiosRequestHeaders } from 'axios';

/**
 * The agent every outbound Live TV request identifies as. Providers block the
 * ffmpeg and axios defaults outright, and some panels reject an empty one, so
 * no call in this module may go out without it: playlist, guide, panel API,
 * ffmpeg and ffprobe all read from here.
 */
export const LIVETV_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

/** Per-source overrides, and whatever the playlist attached to one entry. */
export interface LiveTvRequestIdentity {
  userAgent?: string | null;
  referer?: string | null;
}

/** Narrows anything carrying the two override columns to just the identity. */
export function liveTvIdentityOf(
  source: { userAgent?: string | null; referer?: string | null } | null | undefined,
): LiveTvRequestIdentity {
  return { userAgent: source?.userAgent ?? null, referer: source?.referer ?? null };
}

export function liveTvHeaders(
  identity: LiveTvRequestIdentity = {},
  extra: RawAxiosRequestHeaders = {},
): RawAxiosRequestHeaders {
  const headers: RawAxiosRequestHeaders = {
    'User-Agent': identity.userAgent || LIVETV_USER_AGENT,
    ...extra,
  };
  if (identity.referer) headers['Referer'] = identity.referer;
  return headers;
}

/** ffmpeg and ffprobe take the same identity through their own flags. */
export function liveTvFfmpegHeaderArgs(identity: LiveTvRequestIdentity = {}): string[] {
  const args = ['-user_agent', identity.userAgent || LIVETV_USER_AGENT];
  if (identity.referer) args.push('-headers', `Referer: ${identity.referer}\r\n`);
  return args;
}

/** What a conditional refresh remembers between runs. */
export interface HttpCacheValidators {
  etag?: string | null;
  lastModified?: string | null;
}

export function conditionalHeaders(
  validators: HttpCacheValidators | null | undefined,
): RawAxiosRequestHeaders {
  const headers: RawAxiosRequestHeaders = {};
  if (validators?.etag) headers['If-None-Match'] = validators.etag;
  if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
  return headers;
}

export function readValidators(headers: Record<string, unknown>): HttpCacheValidators {
  const etag = headers['etag'];
  const lastModified = headers['last-modified'];
  return {
    etag: typeof etag === 'string' ? etag : null,
    lastModified: typeof lastModified === 'string' ? lastModified : null,
  };
}

/**
 * A provider that answers 304 has told us the body is unchanged; callers treat
 * that as "nothing to do" rather than as an error, which is what keeps a 12
 * hour refresh cadence from looking like abuse to a panel that rate limits.
 */
export function isNotModified(status: number): boolean {
  return status === 304;
}

export async function liveTvGet<T>(
  url: string,
  identity: LiveTvRequestIdentity,
  config: AxiosRequestConfig = {},
  validators?: HttpCacheValidators | null,
) {
  return axios.get<T>(url, {
    timeout: 30_000,
    maxRedirects: 5,
    ...config,
    headers: liveTvHeaders(identity, {
      ...conditionalHeaders(validators),
      ...(config.headers as RawAxiosRequestHeaders),
    }),
    // A 304 is an answer, not a failure.
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
}
