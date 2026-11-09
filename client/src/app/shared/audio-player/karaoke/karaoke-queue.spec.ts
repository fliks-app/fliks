import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { PartyItem, PartyProposal } from '../../../core/services/api/party-api.service';
import { MusicApiService } from '../../../core/services/api/music-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { DeviceService } from '../../../core/services/device.service';
import { PartyService } from '../../../core/services/party/party.service';
import { KaraokeQueueComponent } from './karaoke-queue';

const song = (id: number, proposedBy: number, queuePosition: number): PartyProposal => ({
  id, item: { title: `Song ${id}`, mediaId: 9, itemId: 5000 + id } as PartyItem, proposedBy, upvoterIds: [], downvoterIds: [], queuePosition,
});

function setup(host: boolean) {
  const queue = signal([song(1, 2, 1), song(2, 3, 2)]);
  const party = {
    singerQueue: queue,
    isHost: () => host,
    party: () => ({ id: 7, guests: [{ userId: 3, username: 'bob' }], host: { userId: 1, username: 'amy' } }),
    members: () => [{ userId: 2, username: 'cara' }],
    proposeTrack: vi.fn().mockResolvedValue(true),
    cancelProposal: vi.fn().mockResolvedValue(undefined),
    playSinger: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({ loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } } }),
      { provide: PartyService, useValue: party },
      { provide: AuthService, useValue: { user: () => ({ id: 2 }) } },
      { provide: DeviceService, useValue: { isTv: () => false } },
      { provide: MusicApiService, useValue: { tracks: vi.fn().mockResolvedValue([]) } },
    ],
  });
  const fixture = TestBed.createComponent(KaraokeQueueComponent);
  fixture.detectChanges();
  return { party, el: fixture.nativeElement as HTMLElement };
}

describe('KaraokeQueueComponent', () => {
  it('lists the songs in order and names the next singer', () => {
    const { el } = setup(false);
    expect(el.querySelectorAll('[data-testid="karaoke-queue-item"]').length).toBe(2);
    expect(el.querySelector('[data-testid="karaoke-queue-next"]')?.textContent).toContain('karaoke.queue_next');
    expect(el.querySelector('[data-testid="karaoke-queue-play-next"]')).toBeNull();
  });

  it('lets a singer cancel only their own song', async () => {
    const { party, el } = setup(false);
    const cancels = el.querySelectorAll<HTMLButtonElement>('[data-testid="karaoke-queue-cancel"]');
    expect(cancels.length).toBe(1);
    cancels[0].click();
    await Promise.resolve();
    expect(party.cancelProposal).toHaveBeenCalledWith(7, 1);
  });

  it('gives the host the play-next button and a cancel on every song', async () => {
    const { party, el } = setup(true);
    expect(el.querySelectorAll('[data-testid="karaoke-queue-cancel"]').length).toBe(2);
    el.querySelector<HTMLButtonElement>('[data-testid="karaoke-queue-play-next"]')!.click();
    await Promise.resolve();
    expect(party.playSinger).toHaveBeenCalledWith(undefined);
  });
});
