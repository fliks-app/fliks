import { Component, input, model, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyService } from '../../core/services/party/party.service';
import { PartyCreateModalComponent } from './party-create-modal';
import { PartyInviteePickerComponent } from './party-invitee-picker';
import { PartyHostSwitchesComponent } from '../player/party/party-host-switches';
import { AUTO_COVER, PartyCoverPickerComponent } from './party-cover-picker';
import { MediaPickerComponent } from '../../shared/components/media-picker/media-picker';

@Component({ selector: 'app-party-invitee-picker', template: '' })
class StubPicker {
  readonly selected = model<number[]>([]);
}

@Component({ selector: 'app-party-cover-picker', template: '' })
class StubCover {
  readonly options = input<unknown>();
  readonly draft = model(AUTO_COVER);
}

@Component({ selector: 'app-party-host-switches', template: '' })
class StubSwitches {
  readonly value = input<unknown>();
}

@Component({ selector: 'app-media-picker', template: '' })
class StubMediaPicker {
  readonly taken = input<unknown>();
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
      remove: { imports: [PartyInviteePickerComponent, PartyHostSwitchesComponent, MediaPickerComponent, PartyCoverPickerComponent] },
      add: { imports: [StubPicker, StubSwitches, StubMediaPicker, StubCover] },
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
    expect(el.textContent).toContain('party.create_programme_later');
    (el.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('items');
    expect(create.mock.calls[0][0]).toMatchObject({ name: 'Friday' });
  });

  it('keeps the prefilled film', async () => {
    const fixture = await open({ title: 'Film', mediaId: 4, mediaFileId: 8 });
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('party.create_programme_later');
    (fixture.nativeElement.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create.mock.calls[0][0].items).toEqual([{ mediaId: 4, mediaFileId: 8 }]);
  });

  it('creates with every title picked, grouped by title, and drops one', async () => {
    const fixture = await open({ title: 'Film', mediaId: 4, mediaFileId: 8 });
    const modal = fixture.componentInstance as unknown as { pick(p: unknown[]): void; remove(id: number): void };
    modal.pick([{ mediaId: 6, episodeId: 60, title: 'Show' }, { mediaId: 6, episodeId: 61, title: 'Show' }]);
    modal.pick([{ mediaId: 7, episodeId: null, title: 'Other' }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Show(2)');
    modal.remove(7);
    (el.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create.mock.calls[0][0].items).toEqual([{ mediaId: 4, mediaFileId: 8 }, { mediaId: 6, episodeId: 60 }, { mediaId: 6, episodeId: 61 }]);
  });

  it('sends the chosen cover, and an upload after creation', async () => {
    const fixture = await open({ title: 'Film', mediaId: 4, mediaFileId: 8 });
    const modal = fixture.componentInstance as unknown as { cover: { set(d: unknown): void } };
    modal.cover.set({ mode: 'item', picked: [{ mediaId: 4 }], file: null });
    const submit = async () => {
      (fixture.nativeElement.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
      await fixture.whenStable();
    };
    await submit();
    expect(create.mock.calls[0][0].cover).toEqual({ kind: 'item', mediaId: 4 });
    expect(create.mock.calls[0][1]).toBeUndefined();
    const file = new File(['x'], 'c.png', { type: 'image/png' });
    modal.cover.set({ mode: 'upload', picked: [], file });
    await submit();
    expect(create.mock.calls[1][0]).not.toHaveProperty('cover');
    expect(create.mock.calls[1][1]).toBe(file);
  });

  it('sends the switches and keeps them for the next party', async () => {
    localStorage.removeItem('fliks.partySwitches');
    const fixture = await open({ title: 'Friday' });
    const modal = fixture.componentInstance as unknown as { setSwitches(p: unknown): void };
    modal.setSwitches({ chatEnabled: false });
    (fixture.nativeElement.querySelector('form.flex') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(create.mock.calls[0][0]).toMatchObject({ policy: 'everyone', reactionsEnabled: true, chatEnabled: false, linkSharing: true });
    expect(JSON.parse(localStorage.getItem('fliks.partySwitches')!)).toMatchObject({ chatEnabled: false });
  });

  it('names the party after the first title picked', async () => {
    const fixture = await open({ title: '' });
    const modal = fixture.componentInstance as unknown as { pick(p: unknown[]): void; name(): string };
    modal.pick([{ mediaId: 6, episodeId: null, title: 'Chosen' }]);
    expect(modal.name()).toBe('Chosen');
  });
});
