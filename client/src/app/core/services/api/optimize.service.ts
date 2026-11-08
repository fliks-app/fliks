import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { firstValueFrom } from 'rxjs';
import type {
  FileOutcome,
  JobState,
  OptimizeJob,
  OptimizeSettings,
  IssuedWorkerToken,
  OptimizeWorker,
  WorkerToken,
  WorkerTokenPatch,
  Queued,
  QueueStatus,
  OptimizePreset,
  OptimizeProfile,
  OptimizeProfileBody,
  OptimizePreview,
  OptimizeSummary,
  ProfileDocument,
} from '../../models/optimize';

@Injectable({ providedIn: 'root' })
export class OptimizeService {
  private readonly http = inject(HttpClient);

  presets() {
    return firstValueFrom(this.http.get<OptimizePreset[]>('/api/optimize/presets'));
  }

  profiles() {
    return firstValueFrom(this.http.get<OptimizeProfile[]>('/api/optimize/profiles'));
  }

  profile(id: number) {
    return firstValueFrom(this.http.get<OptimizeProfile>(`/api/optimize/profiles/${id}`));
  }

  createProfile(body: OptimizeProfileBody) {
    return firstValueFrom(this.http.post<OptimizeProfile>('/api/optimize/profiles', body));
  }

  updateProfile(id: number, body: OptimizeProfileBody) {
    return firstValueFrom(this.http.put<OptimizeProfile>(`/api/optimize/profiles/${id}`, body));
  }

  deleteProfile(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/optimize/profiles/${id}`));
  }

  /** Counts per cost level of a library; `profileId` previews a profile the library does not use yet. */
  preview(libraryId: number, profileId?: number | null) {
    const params: Record<string, number> = profileId == null ? {} : { profileId };
    return firstValueFrom(
      this.http.get<OptimizePreview>(`/api/libraries/${libraryId}/optimize/preview`, { params }),
    );
  }

  summary(libraryId: number) {
    return firstValueFrom(
      this.http.get<OptimizeSummary>(`/api/libraries/${libraryId}/optimize/summary`),
    );
  }

  /** One file against the library's profile, or an unsaved `profile` document (typing mid-value is no toast). */
  previewFile(libraryId: number, fileId: number, profile?: ProfileDocument) {
    return firstValueFrom(
      this.http.post<FileOutcome>(`/api/libraries/${libraryId}/optimize/preview/file`, {
        fileId,
        profile,
      }, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }),
    );
  }

  queueStatus() {
    return firstValueFrom(this.http.get<QueueStatus>('/api/optimize/queue'));
  }

  pause() {
    return firstValueFrom(this.http.post<void>('/api/optimize/queue/pause', {}));
  }

  resume() {
    return firstValueFrom(this.http.post<void>('/api/optimize/queue/resume', {}));
  }

  jobs(opts: { state?: JobState; libraryId?: number | null; limit?: number } = {}) {
    const params: Record<string, string | number> = {};
    if (opts.state) params['state'] = opts.state;
    if (opts.libraryId != null) params['libraryId'] = opts.libraryId;
    if (opts.limit) params['limit'] = opts.limit;
    return firstValueFrom(this.http.get<OptimizeJob[]>('/api/optimize/jobs', { params }));
  }

  /** "Optimize…" (and "Force re-encode" with `force`) on up to 500 files. */
  enqueue(mediaFileIds: number[], force = false) {
    return firstValueFrom(
      this.http.post<Queued[]>('/api/optimize/jobs', { mediaFileIds, force }),
    );
  }

  /** Queues what differs from the library's profile; answers at once, the queueing continues server-side. */
  queueLibrary(libraryId: number) {
    return firstValueFrom(
      this.http.post<{ files: number }>(`/api/libraries/${libraryId}/optimize/queue`, {}),
    );
  }

  retry(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/optimize/jobs/${id}/retry`, {}));
  }

  cancel(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/optimize/jobs/${id}/cancel`, {}));
  }

  cancelMany(ids: number[]) {
    return firstValueFrom(
      this.http.post<{ cancelled: number[] }>('/api/optimize/jobs/cancel', { ids }),
    );
  }

  /** Moves queued jobs to the front, in the order given. */
  prioritize(ids: number[]) {
    return firstValueFrom(this.http.post<{ moved: number }>('/api/optimize/jobs/priority', { ids }));
  }

  restore(id: number) {
    return firstValueFrom(this.http.post<void>(`/api/optimize/jobs/${id}/restore`, {}));
  }

  settings() {
    return firstValueFrom(this.http.get<OptimizeSettings>('/api/optimize/settings'));
  }

  saveSettings(body: OptimizeSettings) {
    return firstValueFrom(this.http.put<OptimizeSettings>('/api/optimize/settings', body));
  }

  workers() {
    return firstValueFrom(this.http.get<OptimizeWorker[]>('/api/optimize/workers'));
  }

  workerTokens() {
    return firstValueFrom(this.http.get<WorkerToken[]>('/api/optimize/workers/tokens'));
  }

  createWorkerToken(name: string) {
    return firstValueFrom(this.http.post<IssuedWorkerToken>('/api/optimize/workers/tokens', { name }));
  }

  patchWorkerToken(id: number, body: WorkerTokenPatch) {
    return firstValueFrom(this.http.patch<void>(`/api/optimize/workers/tokens/${id}`, body));
  }

  revokeWorkerToken(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/optimize/workers/tokens/${id}`));
  }
}
