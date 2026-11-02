import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibrariesApiService, type LibrarySummary } from '../../../core/services/api/libraries-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import { bookSpecProviders } from '../../../features/media-detail/book/book-test-setup';
import { FollowToggleComponent } from './follow-toggle';

const lib = { id: 1, name: 'Books', mediaTypes: ['book'] } as unknown as LibrarySummary;

async function setup(kind: 'person' | 'series', reply: object, canCreate = true) {
  TestBed.configureTestingModule({
    providers: bookSpecProviders(
      { provide: LibrariesApiService, useValue: { listMine: async () => [lib] } },
      { provide: AuthService, useValue: { hasPermission: () => canCreate } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
    ),
  });
  const fixture = TestBed.createComponent(FollowToggleComponent);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('targetId', 7);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  await new Promise((r) => setTimeout(r));
  if (canCreate) {
    http.expectOne(kind === 'person' ? '/api/persons/7/follow' : '/api/collections/7/watch').flush(reply);
  }
  await new Promise((r) => setTimeout(r));
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const by = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
  return { fixture, http, el, by };
}

describe('FollowToggleComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('follows an author with the chosen wants', async () => {
    const { fixture, http, by } = await setup('person', { follow: null, canFollow: true });
    by('follow-start')!.click();
    fixture.detectChanges();
    expect(by('follow-panel')).not.toBeNull();
    by('follow-save')!.click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/persons/7/follow');
    expect(req.request.body).toEqual({
      libraryId: 1,
      wants: [{ family: 'text', language: null }, { family: 'audio', language: null }],
    });
    req.flush({ follow: { libraryId: 1, wants: [], newReleases: true, since: '2026-11-02' }, canFollow: true });
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(by('following')).not.toBeNull();
  });

  it('stops following', async () => {
    const follow = { libraryId: 1, wants: [], newReleases: true, since: '2026-11-02' };
    const { fixture, http, by } = await setup('person', { follow, canFollow: true });
    by('follow-stop')!.click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/persons/7/follow').flush(null);
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(by('follow-start')).not.toBeNull();
  });

  it('is hidden for a person who is no author', async () => {
    const { el } = await setup('person', { follow: null, canFollow: false });
    expect(el.querySelector('[data-testid="follow-toggle"]')).toBeNull();
  });

  it('is hidden without the create permission and calls nothing', async () => {
    const { el, http } = await setup('series', { watch: null }, false);
    http.verify();
    expect(el.querySelector('[data-testid="follow-toggle"]')).toBeNull();
  });

  it('watches a series', async () => {
    const { fixture, http, by } = await setup('series', { watch: null });
    by('follow-start')!.click();
    fixture.detectChanges();
    by('follow-save')!.click();
    const req = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/collections/7/watch');
    req.flush({ watch: { libraryId: 1, wants: [], since: '2026-11-02' } });
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(by('following')).not.toBeNull();
  });
});
