import { Component, provideZonelessChangeDetection, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyApiService, type PartyItem } from '../../core/services/api/party-api.service';
import { MediaService } from '../../core/services/api/media.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { DeviceService } from '../../core/services/device.service';
import { SseService } from '../../core/services/sse.service';
import { MediaPickerComponent } from '../../shared/components/media-picker/media-picker';
import { PartyProgrammeComponent } from './party-programme';
import { PartyMusicPickerComponent } from './party-music-picker';

@Component({ selector: 'app-media-picker', template: '' })
class StubPicker {
  readonly taken = input<unknown>();
  show = vi.fn();
}

@Component({ selector: 'app-party-music-picker', template: '' })
class StubMusicPicker {
  show = vi.fn();
}

const item = (mediaId: number, episodeId: number | null = null): PartyItem =>
  ({ mediaId, episodeId, mediaFileId: null, title: `T${mediaId}`, posterUrl: null, hidden: false }) as PartyItem;
const A = item(1);
const B = item(2, 20);
const C = item(2, 21);

describe('PartyProgrammeComponent', () => {
  const api = { queue: vi.fn(), programme: vi.fn() };
  const getOne = vi.fn();
  const events = new Subject<unknown>();
  const flush = () => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    api.queue.mockReset().mockResolvedValue([A, B, C]);
    api.programme.mockReset().mockResolvedValue({ id: 9 });
  });

  async function setup(host: boolean, live = false, current: PartyItem | null = null, tv = true) {
    TestBed.overrideComponent(PartyProgrammeComponent, { remove: { imports: [MediaPickerComponent, PartyMusicPickerComponent] }, add: { imports: [StubPicker, StubMusicPicker] } });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: PartyApiService, useValue: api },
        { provide: MediaService, useValue: { getOne } },
        { provide: DeviceService, useValue: { isTv: () => tv, isPhone: () => false } },
        { provide: ConfirmationService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
        { provide: SseService, useValue: { partyEvents: events } },
      ],
    });
    const fixture = TestBed.createComponent(PartyProgrammeComponent);
    fixture.componentRef.setInput('partyId', 9);
    fixture.componentRef.setInput('isHost', host);
    fixture.componentRef.setInput('live', live);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    return fixture;
  }
  const el = (f: { nativeElement: unknown }) => f.nativeElement as HTMLElement;
  const rowButtons = (f: { nativeElement: unknown }, row: number) => Array.from(el(f).querySelectorAll('li')[row].querySelectorAll<HTMLButtonElement>('button[data-act]'));
  const ids = (call: number) => api.programme.mock.calls[call][1].map((i: { mediaId: number; episodeId?: number }) => `${i.mediaId}:${i.episodeId ?? ''}`);

  it('shows the list to a member without controls', async () => {
    const f = await setup(false);
    expect(el(f).querySelectorAll('li')).toHaveLength(3);
    expect(el(f).querySelector('button')).toBeNull();
    expect(el(f).querySelector('app-media-picker')).toBeNull();
  });

  it('drags off TV, without the arrows', async () => {
    const f = await setup(true, false, null, false);
    expect(el(f).querySelectorAll('[cdkDragHandle]')).toHaveLength(3);
    expect(el(f).querySelector('[data-act=up]')).toBeNull();
  });

  it('has nothing to reorder with a single item', async () => {
    api.queue.mockResolvedValue([A]);
    const offTv = await setup(true, false, null, false);
    expect(el(offTv).querySelector('[cdkDragHandle]')).toBeNull();
    TestBed.resetTestingModule();
    const onTv = await setup(true);
    expect(el(onTv).querySelector('[data-act=up]')).toBeNull();
  });

  it('moves an item down with the full list in the PUT', async () => {
    const f = await setup(true);
    rowButtons(f, 0)[1].click();
    await flush();
    expect(api.programme).toHaveBeenCalledWith(9, expect.any(Array));
    expect(ids(0)).toEqual(['2:20', '1:', '2:21']);
  });

  it('shows the move at once and disables the first up and the last down', async () => {
    const f = await setup(true);
    expect(rowButtons(f, 0)[0].disabled).toBe(true);
    expect(rowButtons(f, 2)[1].disabled).toBe(true);
    api.programme.mockReturnValue(new Promise(() => {}));
    rowButtons(f, 2)[0].click();
    f.detectChanges();
    expect(el(f).querySelectorAll('li p.font-medium')[1].textContent).toContain('T2');
    expect(f.componentInstance['items']().map((i: PartyItem) => i.episodeId)).toEqual([null, 21, 20]);
  });

  it('keeps the move buttons enabled and the focus on the moved row', async () => {
    const f = await setup(true);
    document.body.append(el(f));
    api.programme.mockReturnValue(new Promise(() => {}));
    const down = rowButtons(f, 0)[1];
    down.focus();
    down.click();
    f.detectChanges();
    await f.whenStable();
    expect(down.disabled).toBe(false);
    expect(document.activeElement).toBe(rowButtons(f, 1)[1]);
    rowButtons(f, 2)[0].click();
    expect(api.programme).toHaveBeenCalledTimes(1);
    el(f).remove();
  });

  it('keeps Add enabled while a save runs, so the picker returns the focus to it', async () => {
    const f = await setup(true);
    api.programme.mockReturnValue(new Promise(() => {}));
    f.componentInstance['append']([{ mediaId: 3, episodeId: null, title: 'T', posterUrl: null }]);
    f.detectChanges();
    expect((el(f).querySelector('[data-act=add]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a row hidden from the host in the PUT, as a neutral row', async () => {
    api.queue.mockResolvedValue([A, { ...B, title: '', hidden: true }, C]);
    const f = await setup(true);
    expect(el(f).querySelectorAll('li')[1].textContent).toContain('party.proposal_hidden');
    rowButtons(f, 0)[1].click();
    await flush();
    expect(ids(0)).toEqual(['2:20', '1:', '2:21']);
  });

  it('sends an accepted proposal back without a confirmation', async () => {
    const f = await setup(true);
    f.componentRef.setInput('proposed', [{ mediaId: 2, episodeId: 20 }]);
    f.detectChanges();
    expect(el(f).querySelectorAll('[data-act=unaccept]')).toHaveLength(1);
    (el(f).querySelector('[data-act=unaccept]') as HTMLButtonElement).click();
    await flush();
    expect(ids(0)).toEqual(['1:', '2:21']);
  });

  it('removes an item', async () => {
    const f = await setup(true);
    rowButtons(f, 1)[2].click();
    await flush();
    expect(ids(0)).toEqual(['1:', '2:21']);
  });

  it('rolls back when the PUT fails', async () => {
    const f = await setup(true);
    api.programme.mockRejectedValue(new Error('boom'));
    rowButtons(f, 1)[2].click();
    await flush();
    f.detectChanges();
    expect(el(f).querySelectorAll('li')).toHaveLength(3);
  });

  it('appends the picker output, dropping what is already there', async () => {
    const f = await setup(true);
    f.componentInstance['append']([
      { mediaId: 2, episodeId: 21, title: 'x', posterUrl: null },
      { mediaId: 2, episodeId: 22, title: 'x', posterUrl: null },
      { mediaId: 3, episodeId: null, title: 'x', posterUrl: null },
    ]);
    await flush();
    expect(ids(0)).toEqual(['1:', '2:20', '2:21', '2:22', '3:']);
  });

  it('shows a track as its title over its album and keeps its item id in the PUT', async () => {
    const trackRow = { ...item(4), itemId: 70, title: 'Song', seriesTitle: 'Al' } as PartyItem;
    api.queue.mockResolvedValue([A, trackRow, { ...trackRow, itemId: 71, title: 'Other' }]);
    const f = await setup(true);
    const li = el(f).querySelectorAll('li')[1];
    expect(li.querySelector('p.font-medium')?.textContent).toContain('Song');
    expect(li.textContent).toContain('Al');
    rowButtons(f, 0)[1].click();
    await flush();
    expect(api.programme.mock.calls[0][1]).toEqual([
      { mediaId: 4, itemId: 70 },
      { mediaId: 1 },
      { mediaId: 4, itemId: 71 },
    ]);
  });

  it('expands an album pick into its tracks, and lets a second track of the album in', async () => {
    getOne.mockResolvedValue({
      id: 4, type: 'album', title: 'Al', posterUrl: null,
      album: { targetEditionId: 1, editions: [{ id: 1, hasFiles: true }], tracks: [{ itemId: 70, editionId: 1, hasFile: true, title: 'A' }, { itemId: 71, editionId: 1, hasFile: true, title: 'B' }] },
    });
    const f = await setup(true);
    await f.componentInstance['append']([{ mediaId: 4, episodeId: null, title: 'Al', posterUrl: null, type: 'album' }]);
    await flush();
    expect(api.programme.mock.calls[0][1].map((i: { itemId?: number }) => i.itemId ?? null)).toEqual([null, null, null, 70, 71]);
  });

  it('refetches the queue on party.programme of its party only', async () => {
    await setup(false);
    expect(api.queue).toHaveBeenCalledTimes(1);
    events.next({ type: 'party.programme', partyId: 4, rev: 2, item: null });
    expect(api.queue).toHaveBeenCalledTimes(1);
    api.queue.mockResolvedValue([A]);
    events.next({ type: 'party.programme', partyId: 9, rev: 3, item: null });
    await flush();
    expect(api.queue).toHaveBeenCalledTimes(2);
  });

  it('highlights the playing item only while live', async () => {
    const f = await setup(false, true, B);
    const lis = el(f).querySelectorAll('li');
    expect(lis[1].getAttribute('aria-current')).toBe('true');
    expect(lis[0].getAttribute('aria-current')).toBeNull();
    TestBed.resetTestingModule();
    const g = await setup(false, false, B);
    expect(el(g).querySelector('[aria-current]')).toBeNull();
  });
});
