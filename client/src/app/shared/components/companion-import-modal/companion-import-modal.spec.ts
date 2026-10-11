import { describe, expect, it, vi } from 'vitest';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { CompanionImportModalComponent } from './companion-import-modal';
import { CompanionImportType } from '../../../core/constants/companion-import';
import { MediaService } from '../../../core/services/api/media.service';
import { SubtitlesApiService } from '../../../core/services/api/subtitles-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { DeviceService } from '../../../core/services/device.service';
import { ToastService } from '../../../core/services/toast.service';

const picked = (cmp: CompanionImportModalComponent, file: File) =>
  cmp.onPicked({ target: { files: [file] } } as unknown as Event);

function setup(types: CompanionImportType[] = ['subtitle', 'edl']) {
  const media = { importEdl: vi.fn().mockResolvedValue({ ranges: 2, rejected: [] }) };
  const subs = { upload: vi.fn().mockResolvedValue({}) };
  const confirm = { confirm: vi.fn().mockResolvedValue(true) };
  const toast = { success: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MediaService, useValue: media },
      { provide: SubtitlesApiService, useValue: subs },
      { provide: ConfirmationService, useValue: confirm },
      { provide: ToastService, useValue: toast },
      { provide: DeviceService, useValue: { filePickerAccept: (a: string) => a } },
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(CompanionImportModalComponent);
  fixture.detectChanges();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  const cmp = fixture.componentInstance;
  cmp.open(1, 5, types, 7);
  return { cmp, media, subs, confirm, toast };
}

describe('CompanionImportModalComponent', () => {
  it('offers only the allowed types, starting on the first', () => {
    const { cmp } = setup(['edl']);
    expect(cmp.types()).toEqual(['edl']);
    expect(cmp.type()).toBe('edl');
  });

  it('prefills language and flags from the file name, and resets them on reopen', () => {
    const { cmp } = setup();
    picked(cmp, new File(['x'], 'Film.en.hi.srt'));
    expect([cmp.language(), cmp.forced(), cmp.hearingImpaired()]).toEqual(['en', false, true]);
    cmp.open(1, 5, ['subtitle']);
    expect([cmp.language(), cmp.forced(), cmp.hearingImpaired()]).toEqual(['en', false, false]);
    picked(cmp, new File(['x'], 'Film.fr.forced.srt'));
    expect([cmp.language(), cmp.forced()]).toEqual(['fr', true]);
    picked(cmp, new File(['x'], 'Film.srt'));
    expect([cmp.language(), cmp.forced()]).toEqual(['en', false]);
  });

  it('rejects .sub, which the server cannot read as cues', () => {
    const { cmp } = setup();
    picked(cmp, new File(['x'], 'Film.sub'));
    expect(cmp.error()).toBe('file_info.import_err_ext');
  });

  it('switches the picker filter with the type', () => {
    const { cmp } = setup();
    expect(cmp.accept()).toContain('.srt');
    cmp.setType('edl');
    expect(cmp.accept()).toBe('.edl');
  });

  it('pre-checks extension and size per type', () => {
    const { cmp } = setup();
    picked(cmp, new File(['x'], 'cuts.edl'));
    expect(cmp.error()).toBe('file_info.import_err_ext');
    cmp.setType('edl');
    picked(cmp, new File([new Uint8Array(1024 * 1024 + 1)], 'cuts.edl'));
    expect(cmp.error()).toBe('file_info.import_err_too_large');
    picked(cmp, new File(['1 2 0'], 'cuts.edl'));
    expect(cmp.error()).toBeNull();
  });

  it('uploads a subtitle through the subtitle API with the guessed language', async () => {
    const { cmp, subs, media } = setup();
    const done = vi.fn();
    cmp.imported.subscribe(done);
    picked(cmp, new File(['x'], 'Film.fr.srt'));
    await cmp.submit();
    expect(subs.upload).toHaveBeenCalledWith(1, expect.any(File), { mediaFileId: 5, episodeId: 7, language: 'fr', forced: false, hearingImpaired: false });
    expect(media.importEdl).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith('subtitle');
  });

  it('imports an EDL, and confirms a replace after a 409', async () => {
    const { cmp, media, confirm, toast } = setup();
    media.importEdl
      .mockRejectedValueOnce(new HttpErrorResponse({ status: 409 }))
      .mockResolvedValueOnce({ ranges: 1, rejected: [{ line: 3, reason: 'x' }] });
    cmp.setType('edl');
    picked(cmp, new File(['1 2 0'], 'cuts.edl'));
    await cmp.submit();
    expect(confirm.confirm).toHaveBeenCalled();
    expect(media.importEdl.mock.calls.map((c) => c[3])).toEqual([false, true]);
    expect(toast.success).toHaveBeenCalledWith('file_info.import_edl_success_ignored');
  });

  it('keeps the dialog open and swallows the error when the upload fails', async () => {
    const { cmp, subs } = setup();
    subs.upload.mockRejectedValue(new HttpErrorResponse({ status: 400 }));
    const done = vi.fn();
    cmp.imported.subscribe(done);
    picked(cmp, new File(['x'], 'Film.fr.srt'));
    await expect(cmp.submit()).resolves.toBeUndefined();
    expect(done).not.toHaveBeenCalled();
    expect(cmp.busy()).toBe(false);
  });

  it('keeps the dialog open when the replace is declined', async () => {
    const { cmp, media, confirm } = setup();
    media.importEdl.mockRejectedValue(new HttpErrorResponse({ status: 409 }));
    confirm.confirm.mockResolvedValue(false);
    const done = vi.fn();
    cmp.imported.subscribe(done);
    cmp.setType('edl');
    picked(cmp, new File(['1 2 0'], 'cuts.edl'));
    await cmp.submit();
    expect(media.importEdl).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });
});
