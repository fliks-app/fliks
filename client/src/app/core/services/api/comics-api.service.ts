import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import type { ComicPageSize } from './comics.models';

@Injectable({ providedIn: 'root' })
export class ComicsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ServerConfigService);
  private readonly auth = inject(AuthService);

  /** The reader reports a failure itself, and a PDF issue answers 404 by design. */
  async pages(itemId: number): Promise<ComicPageSize[]> {
    const res = await firstValueFrom(
      this.http.get<{ pages: ComicPageSize[] }>(`/api/comics/${itemId}/pages`, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
    return res.pages;
  }

  /** `index` is 0-based. A native client is cross-origin, so its token rides in the query like any `<img>` route. */
  pageUrl(itemId: number, index: number, width?: number): string {
    const q = new URLSearchParams();
    if (width) q.set('width', String(width));
    if (this.config.isNative && this.auth.playbackToken) q.set('token', this.auth.playbackToken);
    const qs = q.toString();
    return this.config.resolveUrl(`/api/comics/${itemId}/pages/${index}${qs ? `?${qs}` : ''}`);
  }
}
