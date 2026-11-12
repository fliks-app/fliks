import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { abortable } from '../../utils/abortable';
import type { Media } from './media.service';
import type {
  BookChapter, BookImportBody, BookSeriesPut, BookPreview, BookSearchResult, BookSourceDelete, BookSourcePut,
  BookSources, CollectionDetail, CollectionSummary, PersonListItem, PersonWorks,
} from './books.models';

type Params = Record<string, string | number | boolean>;

/** Plain calls over the book routes; the list and detail of a book are `/api/media`, read through MediaService. */
@Injectable({ providedIn: 'root' })
export class BooksApiService {
  private readonly http = inject(HttpClient);

  chapters(mediaId: number, editionId: number) {
    return firstValueFrom(
      this.http.get<BookChapter[]>(`/api/media/${mediaId}/editions/${editionId}/chapters`),
    );
  }

  collections(params: Params = {}, signal?: AbortSignal) {
    return abortable(this.http.get<CollectionSummary[]>('/api/collections', { params }), signal);
  }

  collection(id: number) {
    return firstValueFrom(this.http.get<CollectionDetail>(`/api/collections/${id}`));
  }

  persons(params: Params = {}, signal?: AbortSignal) {
    return abortable(this.http.get<PersonListItem[]>('/api/persons', { params }), signal);
  }

  personWorks(id: number, role: 'author' | 'narrator') {
    return firstValueFrom(this.http.get<PersonWorks>(`/api/persons/${id}/works`, { params: { role } }));
  }

  personBibliography(id: number) {
    return firstValueFrom(this.http.get<BookSearchResult[]>(`/api/persons/${id}/bibliography`, {
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }));
  }

  preview(provider: string, externalId: string) {
    return firstValueFrom(this.http.get<BookPreview>(`/api/metadata/${provider}/book/${externalId}`));
  }

  import(body: BookImportBody) {
    return firstValueFrom(this.http.post<Media>('/api/media/import', body));
  }

  putSeries(mediaId: number, body: BookSeriesPut) {
    return firstValueFrom(this.http.put(`/api/media/${mediaId}/series`, body));
  }

  deleteSeries(mediaId: number) {
    return firstValueFrom(this.http.delete(`/api/media/${mediaId}/series`));
  }

  sources(mediaId: number) {
    return firstValueFrom(this.http.get<BookSources>(`/api/media/${mediaId}/sources`));
  }

  putSource(mediaId: number, body: BookSourcePut) {
    return firstValueFrom(this.http.put<BookSources>(`/api/media/${mediaId}/sources`, body));
  }

  deleteSource(mediaId: number, q: BookSourceDelete) {
    const params = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)) as Params;
    return firstValueFrom(this.http.delete<BookSources>(`/api/media/${mediaId}/sources`, { params }));
  }
}
