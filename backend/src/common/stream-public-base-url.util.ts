import { Request } from 'express';

/**
 * Base publique pour les URLs de stream atteignables par Chromecast (EXTERNAL_URL ou Host).
 */
export function resolveStreamPublicBaseUrl(req: Request): string {
  if (process.env.EXTERNAL_URL) {
    return process.env.EXTERNAL_URL.replace(/\/+$/, '');
  }
  const host = req.headers.host;
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
    return `${proto}://${host}`;
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}
