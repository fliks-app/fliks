import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SseService } from '../../../core/services/sse.service';
import { sseStub } from '../../../testing/sse.stub';
import { SystemStatusComponent, pluginUpdates } from './status';

describe('pluginUpdates', () => {
  it('lists each plugin an UpdatePlugins run installed', () => {
    const body = { updated: [{ pluginId: 'a', from: '0.3.1', to: '1.0.0' }, { pluginId: 'b', from: '1', to: '2' }], skipped: [] };
    expect(pluginUpdates({ name: 'UpdatePlugins', body })).toBe('a 0.3.1 → 1.0.0, b 1 → 2');
    expect(pluginUpdates({ name: 'UpdatePlugins', body: { updated: [], skipped: [] } })).toBe('');
  });
  it('ignores other rows and a run without an outcome', () => {
    expect(pluginUpdates({ name: 'RefreshPluginSources', body: { updated: [] } })).toBeNull();
    expect(pluginUpdates({ name: 'UpdatePlugins', body: undefined })).toBeNull();
  });
});

describe('SystemStatusComponent: persistence alerts', () => {
  async function render(health: Record<string, unknown>) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        { provide: ConfirmationService, useValue: {} },
        { provide: SseService, useValue: sseStub({ connectionId: signal('c') }) },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SystemStatusComponent);
    fixture.detectChanges();
    http.expectOne('/api/system/health').flush(health);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const health = { version: '7', uptimeSeconds: 1, database: {}, installedPlugins: 0, runningPlugins: 0, restartSupervisor: null };

  it('shows no alert when an older server omits the fields', async () => {
    const el = await render(health);
    expect(el.querySelectorAll('.alert-error')).toHaveLength(0);
  });

  it('shows both alerts when the server says nothing persists', async () => {
    const el = await render({ ...health, confPersistent: false, dataPersistent: false });
    expect(el.querySelectorAll('.alert-error')).toHaveLength(2);
  });
});
