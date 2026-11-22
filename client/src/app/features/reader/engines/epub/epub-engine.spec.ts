import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { EpubNavigator } from '@readium/navigator';
import { Locator } from '@readium/shared';
import { of } from 'rxjs';
import { AnnotationsApiService } from '../../annotations-api.service';
import { AudioPlayerService } from '../../../../core/services/audio-player/audio-player.service';
import { StorageScopeService } from '../../../../core/services/storage-scope.service';
import { ReaderComponent } from '../../reader';
import { ReaderApiService } from '../../reader-api.service';

const nav = { inst: undefined as unknown as { listeners: { positionChanged: (l: unknown) => void }; currentLocation: Locator } };

const T = { mediaId: 3, itemId: 7, fileId: 9 };
const at = (href: string, progression: number, totalProgression: number) =>
  Locator.deserialize({ href, type: 'text/html', locations: { progression, totalProgression } })!;
const positions = [at('a.xhtml', 0, 0), at('a.xhtml', 0.5, 0.25), at('b.xhtml', 0, 0.5), at('b.xhtml', 0.5, 0.75)];
const publication = {
  toc: { items: [] },
  readingOrder: { items: [{ href: 'a.xhtml', mediaType: { isHTML: true } }, { href: 'b.xhtml', mediaType: { isHTML: true } }] },
  metadata: { effectiveReadingProgression: 'ltr' },
};

async function open(saved: unknown) {
  vi.spyOn(EpubNavigator.prototype, 'load').mockImplementation(async function (this: EpubNavigator) {
    nav.inst = this as unknown as typeof nav.inst;
  });
  vi.spyOn(EpubNavigator.prototype, 'registerDecorationObserver').mockImplementation(() => undefined);
  const saveProgressOnExit = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: StorageScopeService, useValue: { suffix: () => 's::1', canPersist: () => true } },
      { provide: AnnotationsApiService, useValue: { list: async () => [] } },
      { provide: AudioPlayerService, useValue: {} },
      {
        provide: ReaderApiService,
        useValue: { open: async () => ({ publication, positions }), release: () => undefined, loadProgress: async () => saved, saveProgress: vi.fn(), saveProgressOnExit },
      },
    ],
  });
  const fixture = TestBed.createComponent(ReaderComponent);
  fixture.componentRef.setInput('format', 'epub');
  fixture.componentRef.setInput('target', T);
  await fixture.whenStable();
  await fixture.whenStable();
  return { fixture, saveProgressOnExit };
}

describe('the reader on an epub', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts on the saved locator', async () => {
    const saved = at('b.xhtml', 0.5, 0.75).serialize();
    await open({ locator: saved, progression: 0.1 });
    expect(nav.inst.currentLocation.href).toBe('b.xhtml');
  });

  it('starts from the progression when no locator was saved', async () => {
    await open({ progression: 0.5 });
    expect(nav.inst.currentLocation).toBe(positions[2]);
  });

  it('starts from the progression when the locator is of another format', async () => {
    await open({ locator: { page: 3 }, progression: 0.5 });
    expect(nav.inst.currentLocation).toBe(positions[2]);
  });

  it('reports nothing for the first relocation, then every later one', async () => {
    const { fixture, saveProgressOnExit } = await open({ progression: 0.5 });
    nav.inst.listeners.positionChanged(positions[0]);
    fixture.componentInstance['s'].flushProgress();
    expect(saveProgressOnExit).not.toHaveBeenCalled();
    nav.inst.listeners.positionChanged(positions[3]);
    fixture.componentInstance['s'].flushProgress();
    expect(saveProgressOnExit).toHaveBeenCalledTimes(1);
    expect(saveProgressOnExit.mock.calls[0][1].progression).toBe(0.75);
  });
});
