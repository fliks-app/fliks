import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { ComicsApiService } from '../../core/services/api/comics-api.service';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import { ComicReaderComponent } from './comic-reader';
import { ReaderApiService } from './reader-api.service';

const T = { mediaId: 3, itemId: 7, fileId: 9 };
const pages = Array.from({ length: 6 }, () => ({ width: 800, height: 1200 }));

async function open(saved: unknown, prefs?: unknown) {
  localStorage.clear();
  if (prefs) localStorage.setItem('reader.comics:s::1', JSON.stringify({ 3: prefs }));
  const saveProgress = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: StorageScopeService, useValue: { suffix: () => 's::1', canPersist: () => true } },
      { provide: ComicsApiService, useValue: { pageUrl: (i: number, _f: number, n: number, w?: number) => `/p/${i}/${n}?width=${w}`, prepare: async () => undefined } },
      { provide: ReaderApiService, useValue: { loadProgress: async () => saved, saveProgress } },
    ],
  });
  const fixture = TestBed.createComponent(ComicReaderComponent);
  fixture.componentRef.setInput('target', T);
  fixture.componentRef.setInput('pages', pages);
  await fixture.whenStable();
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, saveProgress };
}

describe('ComicReaderComponent', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resumes on the saved page, sized to the viewport', async () => {
    const { el } = await open({ locator: { page: 3 } });
    const imgs = el.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/p/7/2?width=512');
  });

  it('shows a webtoon volume as a strip of every page', async () => {
    const { el } = await open(null, { mode: 'webtoon', spread: false });
    expect(el.querySelectorAll('img[data-page]')).toHaveLength(6);
  });

  it('draws a manga spread with the later page on the left', async () => {
    const { el } = await open({ locator: { page: 2 } }, { mode: 'manga', spread: true });
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('src')?.split('?')[0])).toEqual(['/p/7/2', '/p/7/1']);
  });

  it('keeps turning pages with the keyboard while a toolbar button has focus', async () => {
    const { fixture, el } = await open({ locator: { page: 1 } });
    const button = el.querySelector('button')!;
    const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true });
    Object.defineProperty(key, 'keyCode', { value: 39 });
    button.dispatchEvent(key);
    await fixture.whenStable();
    expect(el.querySelector('img')?.getAttribute('src')).toContain('/p/7/1?');
  });
});
