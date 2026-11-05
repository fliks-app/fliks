import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { RequestModalComponent } from './request-modal.component';
import { LibrarySummary } from '../../../../core/services/api/libraries-api.service';
import { CreateRequestBody, RequestsService } from '../../../../core/services/api/requests.service';
import { MetadataService } from '../../../../core/services/api/metadata.service';
import { ToastService } from '../../../../core/services/toast.service';

const library = (id: number, folderIds: number[]): LibrarySummary => ({
  id,
  name: `lib${id}`,
  icon: null,
  color: null,
  mediaTypes: ['movie'],
  defaultQualityProfileId: null,
  defaultLanguageProfileId: null,
  folders: folderIds.map((f) => ({ id: f, name: `f${f}` })),
});

function setup(libraries: LibrarySummary[], qualityProfiles = [{ id: 7, name: 'HD' }]) {
  const sent: CreateRequestBody[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: MetadataService, useValue: {} },
      {
        provide: RequestsService,
        useValue: { create: (b: CreateRequestBody) => (sent.push(b), Promise.resolve({})) },
      },
      { provide: ToastService, useValue: { success: () => undefined } },
    ],
  });
  // jsdom has no modal dialog support.
  HTMLDialogElement.prototype.showModal = () => undefined;
  HTMLDialogElement.prototype.close = () => undefined;
  const fixture = TestBed.createComponent(RequestModalComponent);
  fixture.componentRef.setInput('libraries', libraries);
  fixture.componentRef.setInput('qualityProfiles', qualityProfiles);
  fixture.detectChanges();
  fixture.componentInstance.open({ title: 'T', mediaType: 'movie', titleKey: { tmdbId: 1 } });
  return { cmp: fixture.componentInstance, sent };
}

describe('RequestModalComponent folder', () => {
  it('sends the default folder of a library with several, and the chosen one after a change', async () => {
    const { cmp, sent } = setup([library(1, [10, 11]), library(2, [20, 21])]);
    await cmp.confirm();
    cmp.folderId.set(11);
    await cmp.confirm();
    cmp.selectLibrary(2);
    await cmp.confirm();
    expect(sent.map((b) => [b.libraryId, b.folderId])).toEqual([[1, 10], [1, 11], [2, 20]]);
  });

  it('omits the folder when the library has only one', async () => {
    const { cmp, sent } = setup([library(1, [10])]);
    await cmp.confirm();
    expect(sent[0].folderId).toBeUndefined();
  });

  it('sends the first quality profile', () => {
    const { cmp, sent } = setup([library(1, [10])]);
    expect(cmp.qualityProfileId()).toBe(7);
    expect(cmp.noQualityProfile()).toBe(false);
    void cmp.confirm();
    expect((sent[0] as { qualityProfileId?: number }).qualityProfileId).toBe(7);
  });

  it('refuses to submit without a quality profile', () => {
    expect(setup([library(1, [10])], []).cmp.noQualityProfile()).toBe(true);
  });

  it('keeps the quality select open when the lock carries no profile', () => {
    const { cmp } = setup([library(1, [10])]);
    cmp.open({ title: 'T', mediaType: 'movie', titleKey: { tmdbId: 1 }, profilesLocked: true, lockedQualityProfileId: null });
    expect([cmp.qualityLocked(), cmp.qualityProfileId()]).toEqual([false, 7]);
  });
});
