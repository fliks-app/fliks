import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { NeedsAttentionComponent } from './needs-attention';

const SINCE = '2026-11-20T10:00:00Z';

async function settle(fixture: ComponentFixture<unknown>) {
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('NeedsAttentionComponent', () => {
  async function render() {
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
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(NeedsAttentionComponent);
    fixture.detectChanges();
    return { http, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists one row per check, linking only those with a link', async () => {
    const { http, fixture, el } = await render();
    http.expectOne('/api/system/checks').flush({
      checkedAt: SINCE,
      checks: [
        { key: 'plugin:a', state: 'error', code: 'plugin_failed', params: { plugin: 'a' }, link: '/admin/settings/plugins/a', since: SINCE },
        { key: 'conf', state: 'warn', code: 'conf_volatile', params: {}, link: null, since: SINCE },
        { key: 'x', state: 'warn', code: 'from_the_future', params: {}, link: null, since: SINCE },
      ],
    });
    await settle(fixture);
    expect(el.querySelectorAll('li')).toHaveLength(3);
    expect(el.querySelectorAll('a[href="/admin/settings/plugins/a"]')).toHaveLength(1);
    expect(el.querySelectorAll('li a')).toHaveLength(1);
    expect(el.querySelectorAll('li .text-error')).toHaveLength(1);
    expect(el.querySelectorAll('li .text-warning')).toHaveLength(2);
  });

  it('says all good when nothing is listed', async () => {
    const { http, fixture, el } = await render();
    http.expectOne('/api/system/checks').flush({ checkedAt: null, checks: [] });
    await settle(fixture);
    expect(el.querySelectorAll('li')).toHaveLength(0);
    expect(el.textContent).toContain('system.checks.all_good');
  });

  it('re-runs the checks and disables the button meanwhile', async () => {
    const { http, fixture, el } = await render();
    http.expectOne('/api/system/checks').flush({ checkedAt: null, checks: [] });
    await settle(fixture);
    const button = el.querySelector('button') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    http.expectOne({ method: 'POST', url: '/api/system/checks/run' }).flush({
      checkedAt: SINCE,
      checks: [{ key: 'conf', state: 'warn', code: 'conf_volatile', params: {}, link: null, since: SINCE }],
    });
    await settle(fixture);
    expect(button.disabled).toBe(false);
    expect(el.querySelectorAll('li')).toHaveLength(1);
  });
});
