import type { Request } from 'express';

const NATIVE_ORIGINS = [
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
];

export function isCrossOriginNative(req: Request): boolean {
  const origin = req.headers.origin ?? '';
  return NATIVE_ORIGINS.includes(origin);
}

/** Whether the request reached us over HTTPS. `trust proxy` is enabled (see
 *  main.ts), so `req.secure` already honors `X-Forwarded-Proto` from a TLS-
 *  terminating reverse proxy; the header is checked too as a belt-and-braces.
 *
 *  Cookies must NOT carry `Secure` over plain HTTP — the browser drops them,
 *  which breaks auth for prod instances served over HTTP (LAN / IP:port / a
 *  proxy without TLS). And `SameSite=None` is only valid with `Secure`, so on
 *  HTTP we fall back to `Lax`. */
function isRequestSecure(req: Request): boolean {
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(xfp) ? xfp[0] : xfp) ?? '';
  return proto.split(',')[0].trim().toLowerCase() === 'https';
}

export function cookieOpts(req: Request, maxAgeMs: number) {
  const secure = isRequestSecure(req);
  return {
    httpOnly: true,
    secure,
    sameSite: isCrossOriginNative(req) && secure ? ('none' as const) : ('lax' as const),
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function clearOpts(req: Request) {
  const secure = isRequestSecure(req);
  return {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: isCrossOriginNative(req) && secure ? ('none' as const) : ('lax' as const),
  };
}
