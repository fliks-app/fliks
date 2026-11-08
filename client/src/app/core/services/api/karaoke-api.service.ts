import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import type { KaraokeItemState, KaraokeModel, KaraokeModels, KaraokeStatus, StemKind } from './karaoke.models';

@Injectable({ providedIn: 'root' })
export class KaraokeApiService {
  private readonly http = inject(HttpClient);
  /** Callers show their own state for these failures (engine absent, no stems). */
  private readonly quiet = { context: new HttpContext().set(SKIP_ERROR_TOAST, true) };

  status(): Promise<KaraokeStatus> {
    return firstValueFrom(this.http.get<KaraokeStatus>('/api/karaoke/status'));
  }

  models(): Promise<KaraokeModels> {
    return firstValueFrom(this.http.get<KaraokeModels>('/api/karaoke/models', this.quiet));
  }

  download(id: string, acceptLicence: boolean): Promise<KaraokeModel> {
    return firstValueFrom(this.http.post<KaraokeModel>(`/api/karaoke/models/${encodeURIComponent(id)}/download`, { acceptLicence }));
  }

  deleteModel(id: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/karaoke/models/${encodeURIComponent(id)}`));
  }

  itemState(itemId: number): Promise<KaraokeItemState> {
    return firstValueFrom(this.http.get<KaraokeItemState>(`/api/items/${itemId}/karaoke`, this.quiet));
  }

  prepare(itemId: number, body: { align?: boolean; melody?: boolean } = {}): Promise<KaraokeItemState> {
    return firstValueFrom(this.http.post<KaraokeItemState>(`/api/items/${itemId}/karaoke`, body));
  }

  remove(itemId: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/items/${itemId}/karaoke`));
  }

  /** Same-origin path: the session cookie is the credential. */
  stemUrl(mediaFileId: number, kind: StemKind): string {
    return `/api/media-files/${mediaFileId}/stems/${kind}`;
  }
}
