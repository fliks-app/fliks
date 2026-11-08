import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { MEDIA_KINDS } from '../media-kinds';
import { ServerConfigService } from '../services/server-config.service';
import { targetsActiveServer } from './credentials.interceptor';

const KINDS = MEDIA_KINDS.join(',');

/** Declares the media kinds this build renders: the server omits any other kind from its lists. */
export const kindsInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(ServerConfigService).serverUrl();
  if (!targetsActiveServer(req.url, base)) return next(req);
  return next(req.clone({ setHeaders: { 'X-Fliks-Kinds': KINDS } }));
};
