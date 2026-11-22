import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ServerConfigService } from '../services/server-config.service';
import { targetsActiveServer } from './credentials.interceptor';

/** Declares the UI language: the server answers provider search, previews and discovery in it. */
export const languageInterceptor: HttpInterceptorFn = (req, next) => {
  const base = inject(ServerConfigService).serverUrl();
  const lang = inject(TranslateService).currentLang();
  if (!lang || !targetsActiveServer(req.url, base)) return next(req);
  return next(req.clone({ setHeaders: { 'X-Fliks-Language': lang } }));
};
