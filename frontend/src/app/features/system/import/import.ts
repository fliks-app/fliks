import {
  Component, ChangeDetectionStrategy, signal, inject,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-system-import',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import.html',
})
export class SystemImportComponent {
  private readonly http = inject(HttpClient);

  readonly radarrLoading = signal(false);
  readonly sonarrLoading = signal(false);
  readonly result = signal<{ imported: number; skipped: number; errors: string[] } | null>(null);

  async importRadarr(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.radarrLoading.set(true);
    this.result.set(null);
    const fd = new FormData();
    fd.append('file', file);
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
    try {
      this.result.set(await firstValueFrom(this.http.post<any>('/api/system/import-sonarr', fd)));
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      this.result.set({ imported: 0, skipped: 0, errors: [httpErr.error?.message ?? 'Import failed'] });
    } finally { this.sonarrLoading.set(false); }
  }
}
