import { Component, model, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyService } from '../../core/services/party/party.service';
import { PartyCreateModalComponent } from './party-create-modal';
import { PartyInviteePickerComponent } from './party-invitee-picker';

@Component({ selector: 'app-party-invitee-picker', template: '' })
class StubPicker {
  readonly selected = model<number[]>([]);
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
      remove: { imports: [PartyInviteePickerComponent] },
      add: { imports: [StubPicker] },
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
});
