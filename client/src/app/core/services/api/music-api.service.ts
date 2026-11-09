import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { abortable } from '../../utils/abortable';
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

  tracks(q: TracksQuery = {}, signal?: AbortSignal): Promise<TrackRow[]> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== false) params = params.set(k, String(v));
    return abortable(this.http.get<TrackRow[]>('/api/tracks', { params }), signal);
  }

  people(role: 'artist' | 'composer', q: { libraryId?: number; q?: string; page?: number; limit?: number } = {}, signal?: AbortSignal): Promise<MusicPersonRow[]> {
    let params = new HttpParams().set('role', role);
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params = params.set(k, String(v));
    return abortable(this.http.get<MusicPersonRow[]>('/api/persons', { params }), signal);
  }

  /** The library person of an artist a provider found, created when new. */
  resolveArtist(body: { provider: string; externalId: string }): Promise<{ id: number }> {
    return firstValueFrom(this.http.post<{ id: number }>('/api/persons/resolve', body));
  }

  /** Adds the album of a provider recording with that one track wanted. */
  wantRecording(body: { provider: string; externalId: string; albumExternalId: string; libraryId?: number; folderId?: number }): Promise<{ mediaId: number; itemId: number | null }> {
    return firstValueFrom(this.http.post<{ mediaId: number; itemId: number | null }>('/api/music/want-recording', body));
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
