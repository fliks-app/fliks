import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface Tag {
  id: number;
  label: string;
}

@Injectable({ providedIn: 'root' })
export class TagsApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<Tag[]>('/api/tags'));
  }

  create(label: string) {
    return firstValueFrom(this.http.post<Tag>('/api/tags', { label }));
  }

  update(id: number, label: string) {
    return firstValueFrom(this.http.put<Tag>(`/api/tags/${id}`, { label }));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/tags/${id}`));
  }
}
