import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Media } from './media.service';
import type {
  AlbumCandidate,
  ComposerWork,
  Discography,
  MusicPersonRow,
  TrackRow,
  TracksQuery,
  WorkRecording,
} from './music.models';

@Injectable({ providedIn: 'root' })
export class MusicApiService {
  private readonly http = inject(HttpClient);

  tracks(q: TracksQuery = {}): Promise<TrackRow[]> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== false) params = params.set(k, String(v));
    return firstValueFrom(this.http.get<TrackRow[]>('/api/tracks', { params }));
  }

  people(role: 'artist' | 'composer', q: { libraryId?: number; q?: string; page?: number; limit?: number } = {}): Promise<MusicPersonRow[]> {
    let params = new HttpParams().set('role', role);
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params = params.set(k, String(v));
    return firstValueFrom(this.http.get<MusicPersonRow[]>('/api/persons', { params }));
  }

  discography(personId: number): Promise<Discography> {
    return firstValueFrom(this.http.get<Discography>(`/api/persons/${personId}/discography`));
  }

  composerWorks(personId: number): Promise<ComposerWork[]> {
    return firstValueFrom(this.http.get<ComposerWork[]>(`/api/composers/${personId}/works`));
  }

  workRecordings(workId: number): Promise<WorkRecording[]> {
    return firstValueFrom(this.http.get<WorkRecording[]>(`/api/works/${workId}/recordings`));
  }

  recentlyPlayed(limit = 20): Promise<Media[]> {
    return firstValueFrom(this.http.get<Media[]>('/api/playback/recently-played', { params: { limit } }));
  }

  rate(itemId: number, rating: number): Promise<void> {
    return firstValueFrom(this.http.put<void>(`/api/items/${itemId}/rating`, { rating }));
  }

  clearRating(itemId: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/items/${itemId}/rating`));
  }

  /** Adds an identified album (a provider hit) to a library. */
  importAlbum(body: { provider: string; externalId: string; libraryId?: number; folderId?: number }): Promise<Media> {
    return firstValueFrom(this.http.post<Media>('/api/media/import', { type: 'album', ...body }));
  }

  candidates(mediaId: number): Promise<AlbumCandidate[]> {
    return firstValueFrom(this.http.get<AlbumCandidate[]>(`/api/media/${mediaId}/music/candidates`));
  }

  identify(mediaId: number, c: Pick<AlbumCandidate, 'group'>): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/media/${mediaId}/identify`, { provider: 'musicbrainz', externalId: c.group }));
  }
}
