import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';

export const serverUrlInterceptor: HttpInterceptorFn = (req, next) => {
  const config = inject(ServerConfigService);
  if (!config.requiresServerUrl()) return next(req);

  if (req.url.startsWith('/api') || req.url.startsWith('/i18n')) {
    return next(req.clone({ url: config.resolveUrl(req.url) }));
  }

  return next(req);
};
