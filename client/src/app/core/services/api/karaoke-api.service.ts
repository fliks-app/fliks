import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import type { KaraokeItemState, KaraokeLanguage, KaraokeModel, KaraokeModels, KaraokeStalePage, KaraokeStatus, StemKind } from './karaoke.models';

@Injectable({ providedIn: 'root' })
export class KaraokeApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly serverConfig = inject(ServerConfigService);
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

  verifyModel(id: string): Promise<KaraokeModel> {
    return firstValueFrom(this.http.post<KaraokeModel>(`/api/karaoke/models/${encodeURIComponent(id)}/verify`, {}));
  }

  deleteOrphan(name: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/karaoke/models/orphans/${encodeURIComponent(name)}`));
  }

  async languages(): Promise<KaraokeLanguage[]> {
    return (await firstValueFrom(this.http.get<{ languages: KaraokeLanguage[] }>('/api/karaoke/languages', this.quiet))).languages;
  }

  /** Generated lyrics a model other than their language's aligner timed. */
  staleTracks(): Promise<{ tracks: number; refused: number; running: boolean; total: number; done: number }> {
    return firstValueFrom(this.http.get<{ tracks: number; refused: number; running: boolean; total: number; done: number }>('/api/karaoke/realign', this.quiet));
  }

  staleItems(offset: number): Promise<KaraokeStalePage> {
    return firstValueFrom(this.http.get<KaraokeStalePage>('/api/karaoke/realign/items', { ...this.quiet, params: { offset } }));
  }

  async realign(): Promise<number> {
    return (await firstValueFrom(this.http.post<{ tracks: number }>('/api/karaoke/realign', {}))).tracks;
  }

  itemState(itemId: number): Promise<KaraokeItemState> {
    return firstValueFrom(this.http.get<KaraokeItemState>(`/api/items/${itemId}/karaoke`, this.quiet));
  }

  prepare(itemId: number, body: { align?: boolean; melody?: boolean; force?: boolean } = {}): Promise<KaraokeItemState> {
    return firstValueFrom(this.http.post<KaraokeItemState>(`/api/items/${itemId}/karaoke`, body));
  }

  remove(itemId: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/items/${itemId}/karaoke`));
  }

  /** The CD+G graphics of a track's file, with the same credential rules as a stem. */
  cdgUrl(mediaFileId: number): string {
    return this.credentialed(`/api/media-files/${mediaFileId}/cdg`, mediaFileId);
  }

  /** A same-origin path rides the session cookie; a shell with an absolute server URL carries the file-bound stream token. */
  stemUrl(mediaFileId: number, kind: StemKind): string {
    return this.credentialed(`/api/media-files/${mediaFileId}/stems/${kind}`, mediaFileId);
  }

  private credentialed(path: string, mediaFileId: number): string {
    if (!this.serverConfig.isNative) return path;
    const token = this.auth.playbackTokenFor(mediaFileId);
    return `${this.serverConfig.resolveUrl(path)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  }
}
