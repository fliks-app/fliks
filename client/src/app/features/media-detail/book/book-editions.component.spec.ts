import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it, vi } from 'vitest';
import { audioEditionFixture, bookDetailFixture, textEditionFixture } from '../../../testing/books.fixtures';
import { DeviceService } from '../../../core/services/device.service';
import { DownloadManagerService } from '../../../core/services/download-manager.service';
import { BookEditionsComponent } from './book-editions.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookEditionsComponent', () => {
  const tasks = signal<unknown[]>([]);
  const offline = {
    tasks,
    retryDownload: vi.fn(async () => ({})),
    createBookDownload: vi.fn(async () => ({})),
    deleteDownload: vi.fn(async () => undefined),
  };
  const providers = () => bookSpecProviders({ provide: DownloadManagerService, useValue: offline });

  function render(editions = bookDetailFixture.editions) {
    tasks.set([]);
    TestBed.configureTestingModule({ providers: providers() });
    const fixture = TestBed.createComponent(BookEditionsComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('editions', editions);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists one row per edition with its length', () => {
    const rows = Array.from(render().querySelectorAll('[data-testid="edition-row"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('epub');
    expect(rows[0].textContent).toContain('books_work.pages');
    expect(rows[1].textContent).toContain('10:00:00');
    expect(rows[1].textContent).toContain('Narrator One');
  });

  it('marks an edition without a file', () => {
    const rows = render([{ ...audioEditionFixture, hasFile: false }]).querySelectorAll('[data-testid="edition-row"]');
    expect(rows[0].textContent).toContain('books_work.file_no');
  });

  it('offers a direct download of an edition with a file, except on TV', () => {
    const el = render([{ ...audioEditionFixture, hasFile: true, fileIds: [3] }, { ...audioEditionFixture, hasFile: false, fileIds: [] }]);
    expect(el.querySelectorAll('[data-testid="deliver"]')).toHaveLength(1);
  });

  it('hides the download on TV', () => {
    TestBed.configureTestingModule({ providers: providers() });
    TestBed.inject(DeviceService).formFactor.set('tv');
    const fixture = TestBed.createComponent(BookEditionsComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('editions', [{ ...audioEditionFixture, hasFile: true, fileIds: [3] }]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="deliver"]')).toBeNull();
  });

  it('keeps an edition offline, shows the progress, and removes a finished copy', async () => {
    tasks.set([]);
    TestBed.configureTestingModule({ providers: providers() });
    const fixture = TestBed.createComponent(BookEditionsComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('editions', [{ ...audioEditionFixture, hasFile: true, fileIds: [3], itemId: 9 }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = () => el.querySelector<HTMLButtonElement>('[data-testid="offline"]');
    button()!.click();
    expect(offline.createBookDownload).toHaveBeenCalledWith(expect.objectContaining({ itemId: 9, family: 'audio', mediaId: 1 }));
    tasks.set([{ id: 1, book: { itemId: 9 }, status: 'downloading', progress: 42 }]);
    await fixture.whenStable();
    expect(button()).toBeNull();
    expect(el.querySelector('[data-testid="offline-state"]')?.textContent).toContain('42%');
    const done = { id: 1, book: { itemId: 9 }, status: 'ready', progress: 100 };
    tasks.set([done]);
    await fixture.whenStable();
    button()!.click();
    expect(offline.deleteDownload).toHaveBeenCalledWith(done);
  });

  it('offers no offline copy of a text format the reader cannot open', () => {
    const el = render([{ ...textEditionFixture, format: 'azw3' }]);
    expect(el.querySelector('[data-testid="offline"]')).toBeNull();
  });

  it('offers the devices that accept the format and mails the single file', async () => {
    TestBed.configureTestingModule({ providers: providers() });
    const fixture = TestBed.createComponent(BookEditionsComponent);
    fixture.componentRef.setInput('mediaId', 1);
    fixture.componentRef.setInput('editions', [
      { ...bookDetailFixture.editions[0], family: 'text', format: 'epub', fileIds: [7] },
    ]);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const device = (id: number, name: string, formats: string[]) => ({
      id, name, kind: 'kindle', address: 'me@kindle.com', formats, createdAt: '',
    });
    http.expectOne('/api/email-devices').flush({
      enabled: true,
      canSend: true,
      maxBytes: 1,
      devices: [device(1, 'Kindle', ['epub']), device(2, 'Reader', ['pdf'])],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('[data-testid="send-to"]')!;
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual(['books_work.send_to', 'Kindle']);
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    const req = http.expectOne('/api/email-devices/1/send');
    expect(req.request.body).toEqual({ fileId: 7 });
    req.flush({});
  });
});
