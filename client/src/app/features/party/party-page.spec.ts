import { provideZonelessChangeDetection, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartyApiService, type PartyDto, type PartyItem, type PartyProposal } from '../../core/services/api/party-api.service';
import { MediaService } from '../../core/services/api/media.service';
import { AuthService } from '../../core/services/auth.service';
import { BackgroundService } from '../../core/services/background.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { DeviceService } from '../../core/services/device.service';
import { NavbarService } from '../../core/services/navbar.service';
import { ClockService } from '../../core/services/party/clock.service';
import { PartyService } from '../../core/services/party/party.service';
import { VoiceService } from '../../core/services/party/voice.service';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { TvService } from '../../core/services/tv.service';
import { PartyPageComponent } from './party-page';

const item = (mediaId: number, episodeId: number | null = null) =>
  ({ mediaId, episodeId, mediaFileId: null, title: `T${mediaId}`, posterUrl: null, fanartUrl: null, hidden: false, additionalFanartUrls: [] }) as PartyItem;
const dto = (it: PartyItem | null) =>
  ({ id: 9, name: 'P', status: 'scheduled', scheduledAt: null, host: { userId: 1, username: 'h' }, item: it, playlist: null, memberCount: 1, guests: [], live: null }) as unknown as PartyDto;

describe('PartyPageComponent film selection', () => {
  let api: { get: ReturnType<typeof vi.fn> };
  let getOne: ReturnType<typeof vi.fn>;
  let enter: ReturnType<typeof vi.fn>;
  let connected: ReturnType<typeof signal<boolean>>;
  let lobby: ReturnType<typeof signal<boolean>>;
  let service: { party: ReturnType<typeof signal<PartyDto | null>>; proposals: ReturnType<typeof signal<PartyProposal[]>> };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    TestBed.tick();
  };

  beforeEach(() => {
    api = { get: vi.fn().mockResolvedValue(dto(null)) };
    getOne = vi.fn((id: number) => Promise.resolve({ id, title: `T${id}` }));
    enter = vi.fn().mockResolvedValue(undefined);
    connected = signal(true);
    lobby = signal(false);
    service = { party: signal<PartyDto | null>(null), proposals: signal<PartyProposal[]>([]) };
    const stub = (v: object) => v as never;
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    TestBed.overrideComponent(PartyPageComponent, { set: { template: '', imports: [] } });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ActivatedRoute, useValue: { snapshot: { params: { id: '9' }, queryParams: {} } } },
        { provide: Router, useValue: stub({ getCurrentNavigation: () => null, navigateByUrl: vi.fn() }) },
        { provide: PartyApiService, useValue: api },
        { provide: AuthService, useValue: stub({ user: () => ({ id: 1 }) }) },
        { provide: ConfirmationService, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: TranslateService, useValue: {} },
        { provide: SseService, useValue: stub({ partyEvents: new Subject(), connected }) },
        { provide: ClockService, useValue: stub({ start() {}, stop() {}, serverNow: () => 0 }) },
        { provide: MediaService, useValue: { getOne } },
        {
          provide: PartyService,
          useValue: stub({ ...service, closed: new Subject(), lobby: () => lobby(), isHost: () => true, me: () => null, members: () => [], enter, leave: vi.fn(), applySnapshot: vi.fn() }),
        },
        { provide: VoiceService, useValue: stub({ speaking: () => [] }) },
        { provide: NavbarService, useValue: stub({ enterHeroPage() {}, leaveHeroPage() {} }) },
        { provide: TvService, useValue: {} },
        { provide: BackgroundService, useValue: stub({ set() {}, release() {} }) },
        { provide: DeviceService, useValue: stub({ isTv: () => false }) },
      ],
    });
  });

  it('shows the snapshot a programme edit returns', () => {
    const page = TestBed.createComponent(PartyPageComponent).componentInstance as unknown as {
      apply(d: PartyDto): void;
      head(): { item: PartyItem | null } | null;
    };
    page.apply(dto(item(3, 5)));
    expect(page.head()?.item?.mediaId).toBe(3);
  });

  it('reloads the media when the selection changes', async () => {
    api.get.mockResolvedValue(dto(item(1)));
    const fixture = TestBed.createComponent(PartyPageComponent);
    fixture.detectChanges();
    await flush();
    expect(getOne).toHaveBeenLastCalledWith(1);
    // The joined copy follows `party.programme`.
    const svc = TestBed.inject(PartyService) as unknown as { party: typeof service.party };
    svc.party.set({ ...dto(item(2)) });
    await flush();
    expect(getOne).toHaveBeenLastCalledWith(2);
  });

  it('enables the start with a film or at least one proposal', async () => {
    const fixture = TestBed.createComponent(PartyPageComponent);
    fixture.detectChanges();
    await flush();
    const page = fixture.componentInstance as unknown as { canStart(): boolean };
    const svc = TestBed.inject(PartyService) as unknown as typeof service;
    expect(page.canStart()).toBe(false);
    svc.proposals.set([{ id: 1, item: item(1), proposedBy: 1, voterIds: [1] }]);
    expect(page.canStart()).toBe(true);
    svc.proposals.set([]);
    svc.party.set(dto(item(2)));
    await flush();
    expect(page.canStart()).toBe(true);
  });

  describe('joining the lobby', () => {
    const refusal = (status: number, message: string) => new HttpErrorResponse({ status, error: { message } });
    const mount = async () => {
      api.get.mockResolvedValue(dto(item(1)));
      const fixture = TestBed.createComponent(PartyPageComponent);
      fixture.detectChanges();
      await flush();
      return fixture.componentInstance as unknown as { gone(): boolean; invited(): boolean };
    };

    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('waits for the live stream, then joins quietly', async () => {
      connected.set(false);
      await mount();
      expect(enter).not.toHaveBeenCalled();
      connected.set(true);
      await flush();
      expect(enter).toHaveBeenCalledExactlyOnceWith(9, undefined, true);
    });

    it('retries every 10 s while the server has no stream for this device', async () => {
      enter.mockRejectedValue(refusal(409, 'party.error_no_connection'));
      const page = await mount();
      expect(enter).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();
      expect(enter).toHaveBeenCalledTimes(2);
      expect(page.gone()).toBe(false);
    });

    it.each([[403, 'party.error_kicked'], [403, 'party.error_no_access'], [404, 'party.error_not_found']])(
      'stops on a %s %s refusal and shows the gone page once',
      async (status, message) => {
        enter.mockRejectedValue(refusal(status, message));
        const page = await mount();
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(enter).toHaveBeenCalledTimes(1);
        expect(page.gone()).toBe(true);
      },
    );

    it('offers Decline to an invited user who is in the lobby', async () => {
      const page = await mount();
      const svc = TestBed.inject(PartyService) as unknown as typeof service;
      const invited = { ...dto(item(1)), guests: [{ userId: 1, username: 'me', source: 'invite' }] } as unknown as PartyDto;
      lobby.set(true);
      svc.party.set(invited);
      await flush();
      expect(page.invited()).toBe(true);
      svc.party.set({ ...invited, guests: [{ userId: 1, username: 'me', source: 'link' }] } as unknown as PartyDto);
      await flush();
      expect(page.invited()).toBe(false);
    });
  });
});
