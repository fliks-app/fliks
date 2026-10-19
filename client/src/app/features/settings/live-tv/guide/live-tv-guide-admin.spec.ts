import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LiveTvGuideAdminComponent } from './live-tv-guide-admin';

function createComponent(post: ReturnType<typeof vi.fn>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: HttpClient, useValue: { get: vi.fn(() => of([])), post } as unknown as HttpClient },
    ],
  });
  const fixture = TestBed.createComponent(LiveTvGuideAdminComponent);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('LiveTvGuideAdminComponent - save requirements', () => {
  it('needs a URL for an XMLTV feed and a parent source for a linked guide', async () => {
    const post = vi.fn(() => of({}));
    const c = createComponent(post);
    c.formName.set('Guide');
    c.formKind.set('xmltv');
    c.formUrl.set('  ');
    expect(c.canSave()).toBe(false);
    await c.save();
    expect(post).not.toHaveBeenCalled();

    c.formUrl.set('http://h/guide.xml');
    expect(c.canSave()).toBe(true);

    c.formKind.set('source');
    c.formSourceId.set(null);
    expect(c.canSave()).toBe(false);
    c.formSourceId.set(3);
    expect(c.canSave()).toBe(true);
  });
});
