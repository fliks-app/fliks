import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginViewComponent } from './plugin-view';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import type { ConfigPage } from '../../core/plugin-ui/contribution.types';

function createComponent(
  params: { pluginId: string; view: string },
  registry: { hasPlugin: (id: string) => boolean; configPage: (id: string, view: string) => ConfigPage | undefined },
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap(params)) } },
      { provide: PluginUiRegistryService, useValue: registry },
    ],
  });
  return TestBed.createComponent(PluginViewComponent).componentInstance;
}

describe('PluginViewComponent', () => {
  it('reports unknown_plugin when the plugin is not in the registry', () => {
    const c = createComponent(
      { pluginId: 'fliks.gone', view: 'settings' },
      { hasPlugin: () => false, configPage: () => undefined },
    );
    expect(c.reason()).toBe('unknown_plugin');
  });

  it('reports unknown_view when the plugin exists but has no matching config page', () => {
    const c = createComponent(
      { pluginId: 'fliks.a', view: 'missing' },
      { hasPlugin: () => true, configPage: () => undefined },
    );
    expect(c.reason()).toBe('unknown_view');
  });

  it('reports unsupported_kind when the view resolves — form/providers/table rendering ships later', () => {
    const c = createComponent(
      { pluginId: 'fliks.a', view: 'settings' },
      { hasPlugin: () => true, configPage: () => ({ id: 'settings', labelKey: 'x', fields: [] }) },
    );
    expect(c.reason()).toBe('unsupported_kind');
  });
});
