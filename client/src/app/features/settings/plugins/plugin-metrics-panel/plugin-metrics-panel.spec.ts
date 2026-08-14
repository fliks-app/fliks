import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginMetricsPanelComponent } from './plugin-metrics-panel';
import type { PluginMetricsEntry } from '../../../../core/services/api/plugins-api.service';

function createComponent(entry: PluginMetricsEntry): ComponentFixture<PluginMetricsPanelComponent> {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(PluginMetricsPanelComponent);
  fixture.componentRef.setInput('entry', entry);
  fixture.detectChanges();
  return fixture;
}

describe('PluginMetricsPanelComponent', () => {
  it("renders a process plugin's host-call count, p95, restarts, event drops and RSS", () => {
    const fixture = createComponent({
      pluginId: 'fliks.download',
      kind: 'process',
      metrics: {
        hostCallCount: 42,
        hostCallFailureCount: 3,
        hostCallP95Ms: 128,
        restartCount: 2,
        eventDropCount: 5,
        residentSetSizeBytes: 89_915_392, // ~85.8 MB
      },
    });

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('42');
    expect(text).toContain('3');
    expect(text).toContain('128 ms');
    expect(text).toContain('2');
    expect(text).toContain('5');
    expect(text).toContain('85.8 MB');
    expect((fixture.nativeElement as HTMLElement).querySelector('dl')).not.toBeNull();
  });

  it('renders a data plugin (no supervisor) as not applicable, never as zeros', () => {
    const fixture = createComponent({ pluginId: 'fliks.notify', kind: 'data', metrics: null });

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('dl')).toBeNull();
    expect(el.textContent).toContain('settings.plugins.metrics.not_applicable');
  });

  it('renders a stopped process plugin (metrics null) as not applicable too', () => {
    const fixture = createComponent({ pluginId: 'fliks.download', kind: 'process', metrics: null });

    expect((fixture.nativeElement as HTMLElement).querySelector('dl')).toBeNull();
  });
});
