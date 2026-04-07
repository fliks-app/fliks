import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Media } from './media.service';

export interface Person {
  id: number;
  tmdbId: number;
  name: string;
  avatarUrl: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownForDepartment: string | null;
  metadataRefreshedAt: string | null;
}

export interface PersonDetail {
  person: Person;
  cast: PersonMediaCredit[];
  crew: PersonMediaCredit[];
}

export interface PersonMediaCredit {
  id: number;
  character?: string;
  order?: number;
  job?: string;
  department?: string;
  media: Media;
}

export interface PersonProviderCreditItem {
  externalId: number;
  title: string;
  mediaType: 'movie' | 'series';
  character?: string;
  job?: string;
  department?: string;
  posterUrl: string | null;
  releaseDate: string | null;
  rating: number;
}

export interface PersonProviderCredits {
  cast: PersonProviderCreditItem[];
  crew: PersonProviderCreditItem[];
}

@Injectable({ providedIn: 'root' })
export class PersonsApiService {
  private readonly http = inject(HttpClient);

  search(q: string) {
    return firstValueFrom(
      this.http.get<Person[]>('/api/persons/search', { params: { q } }),
    );
  }

  getOne(id: number) {
    return firstValueFrom(
      this.http.get<PersonDetail>(`/api/persons/${id}`),
    );
  }

  getProviderCredits(id: number) {
    return firstValueFrom(
      this.http.get<PersonProviderCredits>(
        `/api/persons/${id}/provider-credits`,
      ),
    );
  }
}
