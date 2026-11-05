import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import type { Want } from '../../core/services/api/wants-api.service';
import { MediaDetailReleasePickerService } from './media-detail-release-picker.service';
import { ReleaseSearchStreamService } from './release-search-stream.service';
import { ReleaseGrabController } from './release-grab-controller';

const want = (o: Partial<Want>): Want =>
  ({ id: 1, family: 'text', language: null, qualityProfileId: 1, folderId: null, satisfied: false, ...o }) as Want;
const BOOK = { mediaId: 3, kind: 'book' as const, level: 'work' as const };

function setup() {
  const api = { search: vi.fn(async () => []), grab: vi.fn(async () => {}) };
  const modal = { showModal: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ lang: 'en', loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: MediaDetailReleasePickerService, useValue: api },
      { provide: ReleaseSearchStreamService, useValue: { run: (f: (id: string) => Promise<unknown[]>) => f('sid') } },
      { provide: DownloadProgressService, useValue: { markGrabbing: () => () => undefined } },
    ],
  });
  const grabs = TestBed.inject(ReleaseGrabController);
  grabs.attach(() => null, () => modal as never);
  return { api, modal, grabs };
}

describe('ReleaseGrabController', () => {
  it('grabs the best release of every given want, each aimed by its family and language', async () => {
    const { api, grabs } = setup();
    await grabs.grabBest(BOOK, [want({ family: 'text', language: 'fr' }), want({ id: 2, family: 'audio' })]);
    expect(api.grab).toHaveBeenCalledWith({ ...BOOK, family: 'text', language: 'fr' }, {});
    expect(api.grab).toHaveBeenCalledWith({ ...BOOK, family: 'audio', language: null }, {});
    expect(grabs.isBestBusy(BOOK)).toBe(false);
  });

  it('opens the modal on the first want and re-searches when another is picked', async () => {
    const { api, modal, grabs } = setup();
    const audio = want({ id: 2, family: 'audio' });
    await grabs.search(BOOK, [want({}), audio]);
    expect(modal.showModal).toHaveBeenCalledOnce();
    expect(api.search).toHaveBeenLastCalledWith({ ...BOOK, family: 'text', language: null }, undefined, 'sid');
    await grabs.selectWant(audio);
    expect(api.search).toHaveBeenLastCalledWith({ ...BOOK, family: 'audio', language: null }, undefined, 'sid');
    expect(grabs.target()?.family).toBe('audio');
  });

  it('grabs a picked release with the target of the open search', async () => {
    const { api, grabs } = setup();
    await grabs.search(BOOK, [want({})]);
    await grabs.grabRelease({ downloadUrl: 'magnet:x', title: 't', sourceId: 2, allowed: true } as never, 'r1');
    expect(api.grab).toHaveBeenCalledWith(
      { ...BOOK, family: 'text', language: null },
      { downloadUrl: 'magnet:x', sourceTitle: 't', sourceId: 2 },
    );
    expect(grabs.grabState().get('r1')).toBe('ok');
  });
});
