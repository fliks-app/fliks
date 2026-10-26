import { Component, model, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyService } from '../../core/services/party/party.service';
import { PartyCreateModalComponent } from './party-create-modal';
import { PartyInviteePickerComponent } from './party-invitee-picker';
import { MediaPickerComponent } from '../../shared/components/media-picker/media-picker';

@Component({ selector: 'app-party-invitee-picker', template: '' })
class StubPicker {
  readonly selected = model<number[]>([]);
}

@Component({ selector: 'app-media-picker', template: '' })
class StubMediaPicker {
  show = vi.fn();
}

describe('PartyCreateModalComponent', () => {
  const create = vi.fn().mockResolvedValue({});
  const createRequest = signal<unknown>(null);

  beforeEach(() => {
    create.mockClear();
    createRequest.set(null);
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    TestBed.overrideComponent(PartyCreateModalComponent, {
      remove: { imports: [PartyInviteePickerComponent, MediaPickerComponent] },
      add: { imports: [StubPicker, StubMediaPicker] },
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: PartyService, useValue: { createRequest, create } },
      ],
    });
  });

  async function open(req: unknown) {
    const fixture = TestBed.createComponent(PartyCreateModalComponent);
    fixture.detectChanges();
    createRequest.set(req);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('creates a party without a film', async () => {
    const fixture = await open({ title: 'Friday' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('party.create_film_later');
    (el.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('mediaId');
    expect(create.mock.calls[0][0]).toMatchObject({ name: 'Friday' });
  });

  it('keeps the prefilled film', async () => {
    const fixture = await open({ title: 'Film', mediaId: 4, mediaFileId: 8 });
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('party.create_film_later');
    (fixture.nativeElement.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create.mock.calls[0][0]).toMatchObject({ mediaId: 4, mediaFileId: 8 });
  });

  it('creates with the film picked in the dialog, and drops it with Pick later', async () => {
    const fixture = await open({ title: '' });
    const modal = fixture.componentInstance as unknown as { pick(p: unknown[]): void; film: { set(v: null): void }; name(): string };
    modal.pick([{ mediaId: 6, episodeId: 60, title: 'Chosen' }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Chosen');
    expect(modal.name()).toBe('Chosen');
    (el.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create.mock.calls[0][0]).toMatchObject({ mediaId: 6, episodeId: 60 });
    expect(create.mock.calls[0][0]).not.toHaveProperty('mediaFileId');
    create.mockClear();
    modal.film.set(null);
    (el.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create.mock.calls[0][0]).not.toHaveProperty('mediaId');
  });
});
