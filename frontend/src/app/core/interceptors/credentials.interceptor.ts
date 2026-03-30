import { HttpInterceptorFn } from '@angular/common/http';

/** Envoie les cookies (session JWT) sur les appels API proxifiés. */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith('/api')) {
    req = req.clone({ withCredentials: true });
  }
  return next(req);
};
