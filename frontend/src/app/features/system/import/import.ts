import {
  Component, ChangeDetectionStrategy, signal, computed, inject, OnInit,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { LibrariesApiService, Library } from '../../../core/services/api/libraries-api.service';

type LibrarySelection = number | 'new' | null;

@Component({
  selector: 'app-system-import',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import.html',
})
export class SystemImportComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly librariesApi = inject(LibrariesApiService);

  readonly libraries = signal<Library[]>([]);
  readonly movieLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('movie')),
  );
  readonly seriesLibraries = computed(() =>
    this.libraries().filter((l) => l.mediaTypes.includes('series')),
  );

  readonly radarrLibrary = signal<LibrarySelection>(null);
  readonly radarrNewLibraryName = signal('');
  readonly sonarrLibrary = signal<LibrarySelection>(null);
  readonly sonarrNewLibraryName = signal('');

  readonly radarrLoading = signal(false);
  readonly sonarrLoading = signal(false);
  readonly result = signal<{ imported: number; skipped: number; errors: string[] } | null>(null);

  async ngOnInit() {
    try {
      this.libraries.set(await this.librariesApi.list());
    } catch {
      /* optional */
    }
  }

  private appendLibraryFields(fd: FormData, sel: LibrarySelection, newName: string) {
    if (typeof sel === 'number') {
      fd.append('targetLibraryId', String(sel));
    } else if (sel === 'new' && newName.trim()) {
      fd.append('newLibraryName', newName.trim());
    }
  }

  async importRadarr(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.radarrLoading.set(true);
    this.result.set(null);
    const fd = new FormData();
    fd.append('file', file);
    this.appendLibraryFields(fd, this.radarrLibrary(), this.radarrNewLibraryName());
    try {
      this.result.set(await firstValueFrom(this.http.post<any>('/api/system/import-radarr', fd)));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.result.set({ imported: 0, skipped: 0, errors: [httpErr.error?.message ?? 'Import failed'] });
    } finally { this.radarrLoading.set(false); }
  }

  async importSonarr(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.sonarrLoading.set(true);
    this.result.set(null);
    const fd = new FormData();
    fd.append('file', file);
    this.appendLibraryFields(fd, this.sonarrLibrary(), this.sonarrNewLibraryName());
    try {
      this.result.set(await firstValueFrom(this.http.post<any>('/api/system/import-sonarr', fd)));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.result.set({ imported: 0, skipped: 0, errors: [httpErr.error?.message ?? 'Import failed'] });
    } finally { this.sonarrLoading.set(false); }
  }
}
