import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import type { ComicDetail, ComicIssuePatch, ComicPageSize, ComicVolumePatch } from './comics.models';

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

  /** Edits the volume; the fields sent are locked against scans. `null` clears the optional ones. */
  patchVolume(mediaId: number, body: ComicVolumePatch): Promise<ComicDetail> {
    return firstValueFrom(this.http.patch<ComicDetail>(`/api/media/${mediaId}/comic`, body));
  }

  patchIssue(itemId: number, body: ComicIssuePatch): Promise<ComicDetail> {
    return firstValueFrom(this.http.patch<ComicDetail>(`/api/comics/issues/${itemId}`, body));
  }

  /** Mints or renews the stream token of the issue's file, which the native page URLs carry. */
  async prepare(fileId: number): Promise<void> {
    if (this.config.isNative) await this.auth.ensureStreamToken(fileId);
  }

  /** `index` is 0-based. A native client is cross-origin, so the file's stream token rides in the query. */
  pageUrl(itemId: number, fileId: number, index: number, width?: number): string {
    const q = new URLSearchParams();
    if (width) q.set('width', String(width));
    const token = this.config.isNative ? this.auth.playbackTokenFor(fileId) : null;
    if (token) q.set('token', token);
    const qs = q.toString();
    return this.config.resolveUrl(`/api/comics/${itemId}/pages/${index}${qs ? `?${qs}` : ''}`);
  }
}
