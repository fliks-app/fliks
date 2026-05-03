import { Request } from 'express';

/**
 * Base publique pour les URLs de stream atteignables par Chromecast.
 * Priority: DB setting `public_url` > EXTERNAL_URL env > Host header > localhost.
 */
export function resolveStreamPublicBaseUrl(
  req: Request,
  publicUrl?: string | null,
): string {
  if (publicUrl) {
    return publicUrl.replace(/\/+$/, '');
  }
  if (process.env.EXTERNAL_URL) {
    return process.env.EXTERNAL_URL.replace(/\/+$/, '');
  }
  const host = req.headers.host;
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
    return `${proto}://${host}`;
  }
  return `http://localhost:${process.env.PORT || 4848}`;
}
