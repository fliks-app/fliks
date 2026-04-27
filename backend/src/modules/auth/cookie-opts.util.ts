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

export function cookieOpts(req: Request, maxAgeMs: number) {
  if (isCrossOriginNative(req)) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
      path: '/',
      maxAge: maxAgeMs,
    };
  }
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function clearOpts(req: Request) {
  if (isCrossOriginNative(req)) {
    return {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
    };
  }
  return {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
  };
}
