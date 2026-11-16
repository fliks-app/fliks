import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it, vi } from 'vitest';
import { MediaService, type Media } from './api/media.service';
import { ConfirmationService } from './confirmation.service';
import { IdentifyModalService } from './identify-modal.service';
import { MediaAdminService } from './media-admin.service';
import { ToastService } from './toast.service';

function setup(detail: unknown = null) {
  const confirm = vi.fn(async () => true);
  const instant = vi.fn((k: string) => k);
  TestBed.configureTestingModule({
    providers: [
      MediaAdminService,
      { provide: MediaService, useValue: { getOne: vi.fn(async () => detail) } },
      { provide: ConfirmationService, useValue: { confirm } },
      { provide: IdentifyModalService, useValue: {} },
      { provide: ToastService, useValue: {} },
      { provide: Router, useValue: {} },
      { provide: TranslateService, useValue: { instant, currentLang: () => 'en', fallbackLang: () => 'en' } },
    ],
  });
  return { admin: TestBed.inject(MediaAdminService), confirm, instant };
}

describe('MediaAdminService.confirmDelete', () => {
  it('counts the tracks of other albums that play an album\'s files', async () => {
    const { admin, instant } = setup();
    await admin.confirmDelete({ id: 1, type: 'album', title: 'A', album: { tracks: [], sharedTracks: 3 } } as unknown as Media);
    expect(instant).toHaveBeenCalledWith('music.confirm_delete_shared_other', { title: 'A', count: 3 });
  });

  it('reads the count from the detail when it holds a card of the list', async () => {
    const { admin, instant } = setup({ id: 1, type: 'album', title: 'A', album: { tracks: [], sharedTracks: 1 } });
    await admin.confirmDelete({ id: 1, type: 'album', title: 'A', folderName: 'f' } as Media);
    expect(instant).toHaveBeenCalledWith('music.confirm_delete_shared_one', { title: 'A', count: 1 });
  });

  it('keeps the plain message for an album that shares nothing', async () => {
    const { admin, instant } = setup();
    await admin.confirmDelete({ id: 1, type: 'album', title: 'A', folderName: 'f', album: { tracks: [], sharedTracks: 0 } } as unknown as Media);
    expect(instant).toHaveBeenCalledWith('media_detail.confirm_delete', { title: 'A' });
  });
});
