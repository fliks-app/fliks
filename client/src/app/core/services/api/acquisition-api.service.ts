import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';

/** One finished, failed or removed transfer of `GET /api/acquisition/history`. */
export interface AcquisitionHistoryRow {
  id: number;
  mediaId: number;
  /** The release name the provider received. */
  sourceTitle: string;
  state: string;
  statusMessage: string | null;
  date: string;
}

@Injectable({ providedIn: 'root' })
export class AcquisitionApiService {
  private readonly http = inject(HttpClient);

  /** The newest rows of one media; a panel that is only a hint keeps its failure to itself. */
  async history(mediaId: number, pageSize: number): Promise<AcquisitionHistoryRow[]> {
    const res = await firstValueFrom(
      this.http.get<{ data: AcquisitionHistoryRow[] }>('/api/acquisition/history', {
        params: { mediaId, pageSize },
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      }),
    );
    return res.data;
  }
}
