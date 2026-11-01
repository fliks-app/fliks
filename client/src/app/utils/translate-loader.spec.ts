import { HttpBackend, HttpResponse } from '@angular/common/http';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { I18N_FEATURE_FILES, translateBrowserLoaderFactory } from './translate-loader';

describe('translateBrowserLoaderFactory', () => {
  it('merges the namespace files over the core file and tolerates a missing one', async () => {
    const backend = {
      handle: (req: { url: string }) => {
        const path = req.url.split('?')[0];
        if (path === 'i18n/en.json') return of(new HttpResponse({ body: { a: { x: 1 }, kinds: { book: 'Book' } } }));
        if (path === `i18n/${I18N_FEATURE_FILES[0]}/en.json`) return of(new HttpResponse({ body: { a: { y: 2 } } }));
        return throwError(() => new Error('404'));
      },
    } as unknown as HttpBackend;
    const out = await firstValueFrom(translateBrowserLoaderFactory(backend).getTranslation('en'));
    expect(out).toEqual({ a: { x: 1, y: 2 }, kinds: { book: 'Book' } });
  });
});
