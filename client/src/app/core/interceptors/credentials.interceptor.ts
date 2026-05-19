import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';
import { AuthService } from '../services/auth.service';

/**
 * En mode web : envoie les cookies (session JWT) sur les appels API.
 * En mode natif (Capacitor) ou sur Smart TV : ajoute le header
 * Authorization Bearer. Les bundles standalone (Capacitor et TV) servent
 * depuis `file://` et ne reçoivent pas les cookies cross-origin, donc le
 * jeton doit voyager dans l'en-tête.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  const serverConfig = inject(ServerConfigService);
  const auth = inject(AuthService);

  const isApi = req.url.includes('/api');
  if (!isApi) return next(req);

  if (serverConfig.isNative) {
    const token = auth.accessToken;
    if (token) {
      return next(req.clone({
        setHeaders: { Authorization: `Bearer ${token}` },
      }));
    }
    return next(req);
  }

  return next(req.clone({ withCredentials: true }));
};
