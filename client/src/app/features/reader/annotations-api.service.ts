import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type AnnotationColour = 'yellow' | 'green' | 'blue' | 'pink';
export const ANNOTATION_COLOURS: readonly AnnotationColour[] = ['yellow', 'green', 'blue', 'pink'];

export interface Annotation {
  id: number;
  itemId: number;
  kind: 'bookmark' | 'highlight';
  colour: AnnotationColour | null;
  note: string;
  locator: Record<string, unknown>;
  excerpt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewAnnotation {
  kind: Annotation['kind'];
  colour?: AnnotationColour;
  note?: string;
  locator: Record<string, unknown>;
  excerpt?: string;
}

/** `docs/spec/annotations.md`: the caller's own bookmarks and highlights of one text item. */
@Injectable({ providedIn: 'root' })
export class AnnotationsApiService {
  private readonly http = inject(HttpClient);

  list(itemId: number): Promise<Annotation[]> {
    return firstValueFrom(this.http.get<Annotation[]>(`/api/items/${itemId}/annotations`));
  }

  create(itemId: number, body: NewAnnotation): Promise<Annotation> {
    return firstValueFrom(this.http.post<Annotation>(`/api/items/${itemId}/annotations`, body));
  }

  update(id: number, patch: { colour?: AnnotationColour; note?: string }): Promise<Annotation> {
    return firstValueFrom(this.http.patch<Annotation>(`/api/annotations/${id}`, patch));
  }

  remove(id: number): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/annotations/${id}`));
  }
}
