import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  EngineRemoteApiService,
  type EnginePathMapping,
  type EngineRemoteConfig,
  type EngineRemoteStatus,
} from '../../../core/services/api/engine-remote-api.service';
import { SECRET_MASK } from '../../../shared/components/schema-form/schema-form';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-engine-settings',
  imports: [FormsModule, TranslatePipe],
  templateUrl: './engine.html',
})
export class EngineSettingsComponent implements OnInit {
  private readonly api = inject(EngineRemoteApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly testing = signal(false);

  readonly url = signal('');
  readonly token = signal('');
  readonly tokenStored = signal(false);
  readonly tokenCleared = signal(false);
  readonly secretMask = SECRET_MASK;
  readonly probePath = signal('');
  readonly pathMappings = signal<EnginePathMapping[]>([]);
  readonly status = signal<EngineRemoteStatus>('off');
  readonly processUrl = signal('');
  readonly mismatch = signal(false);
  readonly testResult = signal<string | null>(null);

  async ngOnInit() {
    try {
      await this.refresh();
    } catch {
      /* interceptor */
    }
    this.loading.set(false);
  }

  private async refresh() {
    const cfg = await this.api.get();
    this.url.set(cfg.url);
    this.applyToken(cfg);
    this.pathMappings.set(
      cfg.pathMappings.length ? [...cfg.pathMappings] : [{ from: '', to: '' }],
    );
    this.status.set(cfg.status);
    this.processUrl.set(cfg.processUrl);
    this.mismatch.set(!!cfg.mismatch);
  }

  private applyToken(cfg: EngineRemoteConfig) {
    this.token.set(cfg.token ?? '');
    this.tokenStored.set(
      !!cfg.token || !!cfg.secretsSet?.some((k) => k === 'token' || k === 'engine_token'),
    );
    this.tokenCleared.set(false);
  }

  onTokenInput(value: string) {
    this.token.set(value);
    if (value.trim()) this.tokenCleared.set(false);
  }

  /** Blank leaves the stored token alone, `null` erases it, as the API defines. */
  private tokenValue(): string | null | undefined {
    if (this.tokenCleared()) return null;
    const typed = this.token().trim();
    if (typed) return typed;
    return this.tokenStored() ? undefined : '';
  }

  addMapping() {
    this.pathMappings.update((rows) => [...rows, { from: '', to: '' }]);
  }

  removeMapping(index: number) {
    this.pathMappings.update((rows) => rows.filter((_, i) => i !== index));
  }

  updateMapping(index: number, field: 'from' | 'to', value: string) {
    this.pathMappings.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }

  async save() {
    this.saving.set(true);
    this.testResult.set(null);
    try {
      const cfg = await this.api.save({
        url: this.url(),
        token: this.tokenValue(),
        pathMappings: this.pathMappings(),
      });
      this.status.set(cfg.status);
      this.processUrl.set(cfg.processUrl);
      this.mismatch.set(!!cfg.mismatch);
      this.applyToken(cfg);
      this.toast.success(this.translate.instant('settings.engine.saved'));
    } catch {
      /* interceptor */
    }
    this.saving.set(false);
  }

  async testConnection() {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const probe = this.probePath().trim();
      const result = await this.api.test({
        url: this.url(),
        ...(this.token().trim() && { token: this.token().trim() }),
        ...(probe && { probePath: probe }),
      });
      if (!result.ok) {
        this.testResult.set(result.error);
        return;
      }
      const lines = [
        this.translate.instant('settings.engine.test_hello', {
          engine: result.engineVersion,
          protocol: result.protocolVersion,
        }),
      ];
      if (result.probeOk === true) {
        lines.push(this.translate.instant('settings.engine.test_probe_ok'));
      } else if (result.probeOk === false && result.probeError) {
        lines.push(
          this.translate.instant('settings.engine.test_probe_failed', {
            error: result.probeError,
          }),
        );
      }
      this.testResult.set(lines.join('\n'));
    } catch {
      /* interceptor */
    } finally {
      this.testing.set(false);
    }
  }
}
