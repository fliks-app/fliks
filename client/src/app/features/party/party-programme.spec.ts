import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '../../core/services/api/media.service';
import { PartyApiService, type PartyItem } from '../../core/services/api/party-api.service';
import { SseService } from '../../core/services/sse.service';
import { MediaPickerComponent } from '../../shared/components/media-picker/media-picker';
import { PartyProgrammeComponent } from './party-programme';

@Component({ selector: 'app-media-picker', template: '' })
class StubPicker {
  show = vi.fn();
}

const item = (mediaId: number, episodeId: number | null = null): PartyItem =>
  ({ mediaId, episodeId, mediaFileId: null, title: `T${mediaId}`, posterUrl: null }) as PartyItem;
const A = item(1);
const B = item(2, 20);
const C = item(2, 21);

describe('PartyProgrammeComponent', () => {
  const api = { queue: vi.fn(), programme: vi.fn() };
  const events = new Subject<unknown>();
  const flush = () => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    api.queue.mockReset().mockResolvedValue([A, B, C]);
    api.programme.mockReset().mockResolvedValue({ id: 9 });
  });

  async function setup(host: boolean, live = false, current: PartyItem | null = null) {
    TestBed.overrideComponent(PartyProgrammeComponent, { remove: { imports: [MediaPickerComponent] }, add: { imports: [StubPicker] } });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
        { provide: PartyApiService, useValue: api },
        { provide: MediaService, useValue: { getOne: vi.fn().mockResolvedValue(null) } },
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
  const rowButtons = (f: { nativeElement: unknown }, row: number) => Array.from(el(f).querySelectorAll('li')[row].querySelectorAll('button'));
  const ids = (call: number) => api.programme.mock.calls[call][1].map((i: { mediaId: number; episodeId?: number }) => `${i.mediaId}:${i.episodeId ?? ''}`);

  it('shows the list to a member without controls', async () => {
    const f = await setup(false);
    expect(el(f).querySelectorAll('li')).toHaveLength(3);
    expect(el(f).querySelector('button')).toBeNull();
    expect(el(f).querySelector('app-media-picker')).toBeNull();
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
      { mediaId: 2, episodeId: 21 },
      { mediaId: 2, episodeId: 22 },
      { mediaId: 3, episodeId: null },
    ]);
    await flush();
    expect(ids(0)).toEqual(['1:', '2:20', '2:21', '2:22', '3:']);
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
