import { describe, expect, it, vi } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { CompanionFilesModalComponent } from './companion-files-modal';
import { CompanionFile, MediaService } from '../../../core/services/api/media.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

const row = (over: Partial<CompanionFile>): CompanionFile => ({
  name: 'Film.en.srt',
  relativePath: 'Film.en.srt',
  size: 2048,
  mtime: '2026-01-01T00:00:00.000Z',
  kind: 'subtitle',
  scope: 'file',
  subtitle: { id: 9, language: 'en', forced: false, hearingImpaired: false },
  sharedWith: [],
  hasPair: false,
  ...over,
});

function setup(canDelete: boolean, rows: CompanionFile[]) {
  const api = {
    listCompanions: vi.fn().mockResolvedValue(rows),
    deleteCompanion: vi.fn().mockResolvedValue(undefined),
    downloadCompanion: vi.fn().mockResolvedValue(undefined),
  };
  const confirm = { confirm: vi.fn().mockResolvedValue(true) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MediaService, useValue: api },
      { provide: ConfirmationService, useValue: confirm },
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(CompanionFilesModalComponent);
  fixture.componentRef.setInput('canDelete', canDelete);
  fixture.detectChanges();
  HTMLDialogElement.prototype.showModal = vi.fn();
  return { fixture, api, confirm, cmp: fixture.componentInstance };
}

describe('CompanionFilesModalComponent', () => {
  it('groups rows by scope and hides delete without permission', async () => {
    const { fixture, cmp } = setup(false, [row({}), row({ name: 'movie.nfo', relativePath: 'movie.nfo', kind: 'nfo', scope: 'folder', subtitle: null })]);
    await cmp.open(1, 5);
    fixture.detectChanges();
    expect(cmp.thisVideo().length).toBe(1);
    expect(cmp.folder().length).toBe(1);
    expect(fixture.nativeElement.querySelector('button.text-error')).toBeNull();
  });

  it('deletes after confirmation, refreshes and signals a tracked subtitle', async () => {
    const { cmp, api, confirm } = setup(true, [row({})]);
    const emitted = vi.fn();
    cmp.subtitlesChanged.subscribe(emitted);
    await cmp.open(1, 5);
    await cmp.remove(cmp.items()[0]);
    expect(confirm.confirm).toHaveBeenCalled();
    expect(api.deleteCompanion).toHaveBeenCalledWith(1, 5, 'Film.en.srt');
    expect(api.listCompanions).toHaveBeenCalledTimes(2);
    expect(emitted).toHaveBeenCalled();
  });

  it('warns about shared files and VobSub pairs, and formats sizes with the shared helper', async () => {
    const { cmp, confirm } = setup(true, [row({ sharedWith: [{ fileId: 6, name: 'Film.mp4' }], hasPair: true })]);
    await cmp.open(1, 5);
    await cmp.remove(cmp.items()[0]);
    const msg = confirm.confirm.mock.calls[0][0].message as string;
    expect(msg).toContain('file_info.companions_shared_warning');
    expect(msg).toContain('file_info.companions_pair_note');
    expect(cmp.formatSize(0)).toBe('0 B');
  });

  it('shows the primary import button above the list only with an import permission', async () => {
    const { fixture, cmp } = setup(false, [row({})]);
    await cmp.open(1, 5);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.modal-box > div > button.btn-primary')).toBeNull();
    fixture.componentRef.setInput('canManageSubtitles', true);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('.modal-box > div > button.btn-primary') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.compareDocumentPosition(fixture.nativeElement.querySelector('ul'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('downloads a row through the shared API helper', async () => {
    const { fixture, cmp, api } = setup(false, [row({})]);
    await cmp.open(1, 5);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('ul button') as HTMLButtonElement;
    btn.click();
    expect(api.downloadCompanion).toHaveBeenCalledWith(1, 5, cmp.items()[0]);
  });

  describe('kind filter', () => {
    const rows = [
      row({}),
      row({ name: 'Film.edl', relativePath: 'Film.edl', kind: 'edl', subtitle: null }),
      row({ name: 'movie.nfo', relativePath: 'movie.nfo', kind: 'nfo', scope: 'folder', subtitle: null }),
    ];

    it('offers the present kinds, filters both groups and resets on open', async () => {
      const { cmp } = setup(false, rows);
      await cmp.open(1, 5);
      expect(cmp.kinds()).toEqual(['subtitle', 'edl', 'nfo']);
      cmp.kindFilter.set('nfo');
      expect([cmp.thisVideo().length, cmp.folder().length]).toEqual([0, 1]);
      await cmp.open(1, 5);
      expect(cmp.kindFilter()).toBe('');
      expect([cmp.thisVideo().length, cmp.folder().length]).toEqual([2, 1]);
    });

    it('falls back to All when the selected kind disappears after a delete', async () => {
      const { cmp, api } = setup(true, rows);
      await cmp.open(1, 5);
      cmp.kindFilter.set('edl');
      api.listCompanions.mockResolvedValue([rows[0], rows[2]]);
      await cmp.remove(cmp.items()[1]);
      expect(cmp.kinds()).toEqual(['subtitle', 'nfo']);
      expect(cmp.thisVideo().length + cmp.folder().length).toBe(2);
    });
  });
});
