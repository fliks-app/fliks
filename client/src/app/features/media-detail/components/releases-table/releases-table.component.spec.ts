import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ReleasesTableComponent } from './releases-table.component';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import type { MovieRelease } from '../../media-detail-release-picker.service';

const TRANSLATIONS = {
  media_detail: {
    rejection: { QUALITY_NOT_ALLOWED: 'Quality outside profile' },
    grab_rejected_confirm_title: 'Download anyway?',
    grab_rejected_confirm: "This release doesn't match the quality profile:\n{{reason}}",
  },
};

function makeRelease(overrides: Partial<MovieRelease> = {}): MovieRelease {
  return {
    title: 'Placeholder.Title.2020.1080p',
    downloadUrl: 'magnet:placeholder',
    qualityId: 3,
    qualityName: '1080p',
    rank: 30,
    allowed: true,
    customFormatScore: 0,
    blocklisted: false,
    sourceId: 1,
    sourceName: 'indexer',
    languageId: 1,
    languageName: 'English',
    languageAllowed: true,
    size: 1_000_000,
    seeders: 5,
    leechers: 1,
    rejections: [],
    freeleech: false,
    downloadVolumeFactor: 1,
    isFullSeason: false,
    sizeDeviation: null,
    videoCodec: null,
    ...overrides,
  };
}

async function createFixture(releases: MovieRelease[], confirm = vi.fn(() => Promise.resolve(true))) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(TRANSLATIONS) } },
      }),
      { provide: ConfirmationService, useValue: { confirm } },
    ],
  });
  const fixture = TestBed.createComponent(ReleasesTableComponent);
  fixture.componentRef.setInput('releases', releases);
  fixture.componentRef.setInput('canGrab', true);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, confirm };
}

describe('ReleasesTableComponent — grab control gating', () => {
  it('renders no grab control at all for a blocklisted release', async () => {
    const { fixture } = await createFixture([makeRelease({ blocklisted: true, allowed: false })]);
    expect(fixture.nativeElement.querySelectorAll('button').length).toBe(0);
  });

  it('an allowed release grabs immediately, without confirming', async () => {
    const { fixture, confirm } = await createFixture([makeRelease({ allowed: true })]);
    let emitted: { release: MovieRelease; index: number } | undefined;
    fixture.componentInstance.grab.subscribe((e) => (emitted = e));

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.className).toContain('btn-ghost');
    button.click();
    await fixture.whenStable();

    expect(confirm).not.toHaveBeenCalled();
    expect(emitted?.index).toBe(0);
  });

  it('a rejected (non-blocklisted) release confirms first, naming the reason, then grabs', async () => {
    const release = makeRelease({ allowed: false, rejections: [{ code: 'QUALITY_NOT_ALLOWED' }] });
    const { fixture, confirm } = await createFixture([release]);
    let emitted: { release: MovieRelease; index: number } | undefined;
    fixture.componentInstance.grab.subscribe((e) => (emitted = e));

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.className).toContain('btn-warning');
    button.click();
    await fixture.whenStable();

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Quality outside profile'),
        variant: 'warning',
      }),
    );
    expect(emitted?.release).toBe(release);
  });

  it('declining the confirmation on a rejected release never grabs', async () => {
    const release = makeRelease({ allowed: false, rejections: [{ code: 'QUALITY_NOT_ALLOWED' }] });
    const { fixture } = await createFixture([release], vi.fn(() => Promise.resolve(false)));
    let emitted = false;
    fixture.componentInstance.grab.subscribe(() => (emitted = true));

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    button.click();
    await fixture.whenStable();

    expect(emitted).toBe(false);
  });
});
