import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { MediaType } from '../../enums/media-type.enum';
import type { MediaFamily } from '../../media-kinds';

export type WantFamily = 'text' | 'audio';

/** One wished edition: a family and an edition language (`null` is any). */
export interface WantSpec {
  family: WantFamily;
  language: string | null;
  qualityProfileId?: number | null;
}

// GET/PUT /api/media/:id/wants
export interface Want extends Omit<WantSpec, 'family'> {
  id: number;
  family: MediaFamily;
  qualityProfileId: number | null;
  folderId: number | null;
  satisfied: boolean;
}

// GET /api/persons/:id/follow
export interface PersonFollow {
  newReleases: boolean;
  libraryId: number;
  wants: WantSpec[];
  since: string;
}
export interface PersonFollowState {
  follow: PersonFollow | null;
  canFollow: boolean;
}

// GET /api/collections/:id/watch
export interface SeriesWatch {
  libraryId: number;
  wants: WantSpec[];
  since: string;
}

export interface FollowBody {
  libraryId: number;
  wants?: WantSpec[];
  newReleases?: boolean;
}

// GET /api/wanted
export interface WantedRow {
  mediaId: number;
  type: MediaType;
  title: string;
  year: number | null;
  posterUrl: string | null;
  releaseDate: string | null;
  family: string;
  language: string | null;
  wantId: number;
}
export interface WantedPage {
  data: WantedRow[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class WantsApiService {
  private readonly http = inject(HttpClient);

  async wants(mediaId: number) {
    const r = await firstValueFrom(this.http.get<{ wants: Want[] }>(`/api/media/${mediaId}/wants`));
    return r.wants;
  }

  async setWants(mediaId: number, wants: WantSpec[]) {
    const r = await firstValueFrom(this.http.put<{ wants: Want[] }>(`/api/media/${mediaId}/wants`, { wants }));
    return r.wants;
  }

  wanted(params: Record<string, string | number>) {
    return firstValueFrom(this.http.get<WantedPage>('/api/wanted', { params }));
  }

  personFollow(id: number) {
    return firstValueFrom(this.http.get<PersonFollowState>(`/api/persons/${id}/follow`));
  }

  followPerson(id: number, body: FollowBody) {
    return firstValueFrom(this.http.put<PersonFollowState>(`/api/persons/${id}/follow`, body));
  }

  unfollowPerson(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/persons/${id}/follow`));
  }

  async seriesWatch(id: number) {
    const r = await firstValueFrom(this.http.get<{ watch: SeriesWatch | null }>(`/api/collections/${id}/watch`));
    return r.watch;
  }

  async watchSeries(id: number, body: Omit<FollowBody, 'newReleases'>) {
    const r = await firstValueFrom(this.http.put<{ watch: SeriesWatch | null }>(`/api/collections/${id}/watch`, body));
    return r.watch;
  }

  unwatchSeries(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/collections/${id}/watch`));
  }
}
