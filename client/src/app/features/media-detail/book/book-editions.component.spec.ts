import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { describe, expect, it } from 'vitest';
import { audioEditionFixture, bookDetailFixture } from '../../../core/services/api/books.fixtures';
import { DeviceService } from '../../../core/services/device.service';
import { BookEditionsComponent } from './book-editions.component';
import { bookSpecProviders } from './book-test-setup';

describe('BookEditionsComponent', () => {
  function render(editions = bookDetailFixture.editions) {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookEditionsComponent);
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
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    TestBed.inject(DeviceService).formFactor.set('tv');
    const fixture = TestBed.createComponent(BookEditionsComponent);
    fixture.componentRef.setInput('editions', [{ ...audioEditionFixture, hasFile: true, fileIds: [3] }]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="deliver"]')).toBeNull();
  });

  it('offers the devices that accept the format and mails the single file', async () => {
    TestBed.configureTestingModule({ providers: bookSpecProviders() });
    const fixture = TestBed.createComponent(BookEditionsComponent);
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
