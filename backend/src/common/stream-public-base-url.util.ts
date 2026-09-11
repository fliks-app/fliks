import { Request } from 'express';

/**
 * Base publique pour les URLs de stream atteignables par Chromecast.
 * Priority: DB setting `public_url` > Host header > localhost. Behind a reverse
 * proxy the Host header is often the container's own address, so casting needs
 * the setting.
 */
export function resolveStreamPublicBaseUrl(
  req: Request,
  publicUrl?: string | null,
): string {
  if (publicUrl) {
    return publicUrl.replace(/\/+$/, '');
  }
  const host = req.headers.host;
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
    return `${proto}://${host}`;
  }
  return `http://localhost:${process.env.PORT || 4848}`;
}
