import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { SKIP_ERROR_TOAST } from '../../interceptors/error.interceptor';
import { firstValueFrom } from 'rxjs';
import type {
  FileOutcome,
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
}
