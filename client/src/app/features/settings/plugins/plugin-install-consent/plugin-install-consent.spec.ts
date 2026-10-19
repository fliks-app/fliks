import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { PluginInstallConsentComponent } from './plugin-install-consent';
import { PluginsApiService } from '../../../../core/services/api/plugins-api.service';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

function setup() {
  const api = {
    discardStaged: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue({ pluginId: 'a.b', version: '1', status: 'active' }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: PluginsApiService, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(PluginInstallConsentComponent);
  fixture.detectChanges();
  return { api, c: fixture.componentInstance };
}

const report = { installable: true, stagingId: 's'.repeat(32), sha256: 'h'.repeat(64) };

describe('PluginInstallConsentComponent — staged upload', () => {
  it('discards the staged upload when the sheet closes unconfirmed, once', () => {
    const { api, c } = setup();
    c.open(report);
    c.discardUnconfirmed();
    c.discardUnconfirmed();
    expect(api.discardStaged).toHaveBeenCalledTimes(1);
    expect(api.discardStaged).toHaveBeenCalledWith(report.stagingId);
  });

  it('keeps nothing to discard after a confirm', async () => {
    const { api, c } = setup();
    c.open({ ...report, signature: 'official' });
    await c.confirm();
    c.discardUnconfirmed();
    expect(api.confirm).toHaveBeenCalled();
    expect(api.discardStaged).not.toHaveBeenCalled();
  });

  it('has nothing to discard for a refused report', () => {
    const { api, c } = setup();
    c.open({ installable: false, refusalCode: 'PLUGIN_BAD_ZIP' });
    c.discardUnconfirmed();
    expect(api.discardStaged).not.toHaveBeenCalled();
  });
});
