import { Component, OnInit, inject, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  Library,
  LibrariesApiService,
} from '../../../core/services/api/libraries-api.service';

@Component({
  selector: 'app-libraries-settings',
  imports: [RouterLink, TranslatePipe, UpperCasePipe],
  templateUrl: './libraries.html',
})
export class LibrariesSettingsComponent implements OnInit {
  private readonly api = inject(LibrariesApiService);
  private readonly translate = inject(TranslateService);

  readonly libraries = signal<Library[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');

  ngOnInit() {
    void this.reload();
  }

  async reload() {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.libraries.set(await this.api.list());
    } catch {
      this.listError.set(this.translate.instant('settings.libraries.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  formatBytes(bytes: number): string {
    if (bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let val = bytes;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  freeSpace(lib: Library): number {
    const d = lib.disk;
    return d && d.freeSpace > 0 ? d.freeSpace : 0;
  }

  totalCapacity(lib: Library): number {
    const d = lib.disk;
    return d && d.totalSpace > 0 ? d.totalSpace : 0;
  }
}
