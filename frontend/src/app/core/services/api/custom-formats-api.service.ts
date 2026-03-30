import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface CustomFormatSpec {
  type: 'title_regex' | 'source' | 'resolution' | 'language';
  value: string;
  negate?: boolean;
  required?: boolean;
}

export interface CustomFormat {
  id: number;
  name: string;
  score: number;
  specs: CustomFormatSpec[];
}

export interface CreateCustomFormatBody {
  name: string;
  score?: number;
  specs?: CustomFormatSpec[];
}

@Injectable({ providedIn: 'root' })
export class CustomFormatsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<CustomFormat[]>('/api/custom-formats'));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<CustomFormat>(`/api/custom-formats/${id}`));
  }

  create(body: CreateCustomFormatBody) {
    return firstValueFrom(this.http.post<CustomFormat>('/api/custom-formats', body));
  }

  update(id: number, body: Partial<CreateCustomFormatBody>) {
    return firstValueFrom(this.http.put<CustomFormat>(`/api/custom-formats/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/custom-formats/${id}`));
  }
}
