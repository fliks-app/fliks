import axios, { type AxiosRequestConfig, type RawAxiosRequestHeaders } from 'axios';
import * as dns from 'dns';
import { isInternalAddress } from '../plugins/internal-address';

/** A published XMLTV guide can run to hundreds of megabytes; this only stops
 *  an unbounded response (a runaway or hostile server), not a large one. */
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;

/**
 * Re-resolved on every call, not cached: a hostname that was external when a
 * source was configured can be repointed at an internal address later (DNS
 * rebinding). Narrows but does not eliminate the gap — axios re-resolves the
 * same name to actually connect, leaving a window between this check and that
 * connect(). A source deliberately on the LAN (a set-top box) is refused too;
 * `isInternalAddress` has no per-source exception.
 */
async function assertNotInternal(rawUrl: string): Promise<void> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return; // Let axios raise its own error for a URL it cannot parse either.
  }
  let addresses: string[];
  try {
    addresses = (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);
  } catch (err) {
    throw new Error(`Could not resolve "${hostname}": ${(err as Error).message}`);
  }
  const internal = addresses.find(isInternalAddress);
  if (internal) {
    throw new Error(`Refused: "${hostname}" resolves to an internal address (${internal})`);
  }
}

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
  await assertNotInternal(url);
  return axios.get<T>(url, {
    timeout: 30_000,
    maxRedirects: 5,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    ...config,
    headers: liveTvHeaders(identity, {
      ...conditionalHeaders(validators),
      ...(config.headers as RawAxiosRequestHeaders),
    }),
    // A 304 is an answer, not a failure.
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
}
