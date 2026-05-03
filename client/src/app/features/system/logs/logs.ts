import {
  Component, ChangeDetectionStrategy, signal, inject, OnInit, OnDestroy,
} from '@angular/core';
import { DatePipe, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-system-logs',
  imports: [TranslateModule, DatePipe, NgClass, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './logs.html',
})
export class SystemLogsComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);

  readonly logs = signal<{ timestamp: string; level: string; context: string; message: string }[]>([]);
  readonly loading = signal(false);
  readonly logLevel = signal('');
  readonly logSearch = signal('');
  private interval: any;

  ngOnInit() {
    this.load();
    this.interval = setInterval(() => this.load(), 5000);
  }

  ngOnDestroy() { clearInterval(this.interval); }

  async load() {
    this.loading.set(true);
    try {
      const params: Record<string, string> = { limit: '200' };
      if (this.logLevel()) params['level'] = this.logLevel();
      if (this.logSearch()) params['q'] = this.logSearch();
      this.logs.set(await firstValueFrom(this.http.get<any[]>('/api/system/logs', { params })));
    } finally { this.loading.set(false); }
  }
}
