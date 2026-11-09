import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastService } from '../../../core/services/toast.service';
import { MediaWantsComponent } from './media-wants';
import { bookSpecProviders } from '../../../features/media-detail/book/book-test-setup';

const want = (id: number, family: string, language: string | null, satisfied: boolean) => ({
  id, family, language, qualityProfileId: null, folderId: null, satisfied,
});

describe('MediaWantsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows what is owned and saves the edited wants', async () => {
    TestBed.configureTestingModule({
      providers: bookSpecProviders({ provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } }),
    });
    const fixture = TestBed.createComponent(MediaWantsComponent);
    fixture.componentRef.setInput('mediaId', 3);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    await new Promise((r) => setTimeout(r));
    http.expectOne('/api/media/3/wants').flush({ wants: [want(1, 'audio', 'en', false), want(2, 'text', 'fr', true)] });
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="want-state"]')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="want-state"]')[1].textContent).toContain('wants.owned');

    (el.querySelector('[data-testid="wants-save"]') as HTMLButtonElement).click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/media/3/wants');
    expect(req.request.body).toEqual({
      wants: [
        { family: 'audio', language: 'en', qualityProfileId: null },
        { family: 'text', language: 'fr', qualityProfileId: null },
      ],
    });
    req.flush({ wants: [want(1, 'audio', 'en', false)] });
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid="want-state"]')).toHaveLength(1);
  });
});
