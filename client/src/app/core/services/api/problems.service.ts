import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { SERVER_SINCE, type ServerVersionService } from '../server-version.service';

export const PROBLEM_KINDS = ['video', 'audio', 'subtitles', 'playback', 'other'] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export type ProblemStatus = 'open' | 'acknowledged' | 'resolved' | 'closed';
/** `active` is open plus acknowledged. */
export type ProblemStatusFilter = ProblemStatus | 'active';

export interface ProblemUser {
  id: number;
  username: string;
  avatar?: string | null;
}

export interface ProblemComment {
  id: number;
  createdAt: string;
  updatedAt: string;
  issueId: number;
  userId: number | null;
  user: ProblemUser | null;
  message: string;
}

export interface ProblemRow {
  id: number;
  createdAt: string;
  updatedAt: string;
  status: ProblemStatus;
  kind: ProblemKind;
  itemId: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  fileSize: number | null;
  autoResolved: boolean;
  resolvedAt: string | null;
  media: { id: number; type: string; title: string; posterUrl: string | null };
  file: { id: number; name: string; quality: string | null; size: number } | null;
  /** Null for a row the health job opened. */
  user: ProblemUser | null;
  resolvedBy: ProblemUser | null;
  commentCount: number;
  lastReply: ProblemComment | null;
  source: 'user' | 'health';
}

/** The reporter's latest playback session of the pinned file, managers only; its shape is the server's QoE row. */
export type ProblemPlayback = Record<string, unknown> | null;

export interface ProblemDetail extends ProblemRow {
  comments: ProblemComment[];
  playback?: ProblemPlayback;
}

export interface ProblemsPage {
  data: ProblemRow[];
  total: number;
}

export interface CreateProblemBody {
  kind: ProblemKind;
  itemId?: number;
  seasonNumber?: number;
  mediaFileId?: number;
  note?: string;
}

export const PROBLEM_STATUS_FILTERS: readonly ProblemStatusFilter[] = ['active', 'resolved', 'closed'];

export interface ListProblemsParams {
  status?: ProblemStatusFilter;
  mediaId?: number;
  page?: number;
  limit?: number;
}

/** The reporter can reopen a fixed report this long after it was resolved. */
export const PROBLEM_REOPEN_DAYS = 14;

/** Whether the connected server serves the problem routes: every caller gates its entry point on this. */
export const problemsSupported = (version: Pick<ServerVersionService, 'supports'>) => version.supports(SERVER_SINCE.problems);

@Injectable({ providedIn: 'root' })
export class ProblemsService {
  private readonly http = inject(HttpClient);

  /** `skipToast`: the caller reports a 409 itself and keeps its dialog open. */
  create(mediaId: number, body: CreateProblemBody, skipToast = false) {
    const context = skipToast ? new HttpContext().set(SKIP_ERROR_TOAST, true) : undefined;
    return firstValueFrom(this.http.post<ProblemRow>(`/api/media/${mediaId}/problems`, body, { context }));
  }

  list(params: ListProblemsParams = {}) {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') httpParams = httpParams.set(key, String(value));
    }
    return firstValueFrom(this.http.get<ProblemsPage>('/api/problems', { params: httpParams }));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<ProblemDetail>(`/api/problems/${id}`));
  }

  resolve(id: number, reply?: string) {
    return firstValueFrom(this.http.post<ProblemRow>(`/api/problems/${id}/resolve`, reply ? { reply } : {}));
  }

  close(id: number, reason: string) {
    return firstValueFrom(this.http.post<ProblemRow>(`/api/problems/${id}/close`, { reason }));
  }

  reopen(id: number, note?: string, skipToast = false) {
    const context = skipToast ? new HttpContext().set(SKIP_ERROR_TOAST, true) : undefined;
    return firstValueFrom(this.http.post<ProblemRow>(`/api/problems/${id}/reopen`, note ? { note } : {}, { context }));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/problems/${id}`));
  }

  comments(id: number) {
    return firstValueFrom(this.http.get<ProblemComment[]>(`/api/problems/${id}/comments`));
  }

  comment(id: number, message: string) {
    return firstValueFrom(this.http.post<ProblemComment>(`/api/problems/${id}/comments`, { message }));
  }

  removeComment(commentId: number) {
    return firstValueFrom(this.http.delete<void>(`/api/problems/comments/${commentId}`));
  }
}
