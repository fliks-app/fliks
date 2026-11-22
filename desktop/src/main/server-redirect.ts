import { net } from 'electron';
import { httpsUpgradeOrigin } from './trusted-servers';

const TIMEOUT_MS = 5000;

/** The https origin an http server redirects its API to (null if none): the redirect is read, never followed. */
export async function httpsUpgrade(url: unknown): Promise<string | undefined> {
  if (typeof url !== 'string' || !url.startsWith('http://')) return undefined;
  return new Promise((resolve) => {
    const request = net.request({ url: `${new URL(url).origin}/api/auth/me`, redirect: 'manual' });
    const done = (origin: string | null) => {
      clearTimeout(timer);
      request.abort();
      resolve(origin ?? undefined);
    };
    const timer = setTimeout(() => done(null), TIMEOUT_MS);
    request.on('redirect', (_status, _method, location) => done(httpsUpgradeOrigin(url, location)));
    request.on('response', () => done(null));
    request.on('error', () => done(null));
    request.end();
  });
}
