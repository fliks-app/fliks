import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { LyricsCue, StructuredLyrics } from '../api/lyrics.models';
import { AudioPlayerService } from '../audio-player/audio-player.service';
import { AuthService } from '../auth.service';
import { PartyService } from '../party/party.service';
import { DeviceService } from '../device.service';
import { KaraokeRelayService } from './karaoke-relay.service';
import { KaraokeService } from './karaoke.service';

const cue = (start: number, end: number, pitch: number): LyricsCue => ({ start, end, value: 'x', byteStart: 0, byteEnd: 1, pitch });
const doc = {
  id: 1, kind: 'main', lang: 'en', synced: true, offset: 0, displayArtist: '', displayTitle: '', source: 's', reviewed: false, preferred: true, line: [],
  agents: [{ id: 'v1', role: 'main' }],
  cueLine: [{ index: 0, agentId: 'v1', start: 0, end: 1000, value: 'x', cue: [cue(0, 1000, 60)] }],
} as StructuredLyrics;
const take = (midi: number | null) => Array.from({ length: 50 }, (_, i) => ({ t: i * 20, midi }));

function setup() {
  const received = new Subject<{ userId: number; frames: { t: number; midi: number | null }[] }>();
  const track = signal<{ itemId: number } | null>({ itemId: 1 });
  TestBed.configureTestingModule({
    providers: [
      KaraokeService,
      { provide: AudioPlayerService, useValue: { track, position: signal(0), playing: signal(false), rate: signal(1) } },
      { provide: KaraokeRelayService, useValue: { received, open: vi.fn(), close: vi.fn(), send: vi.fn() } },
      { provide: DeviceService, useValue: { isTv: () => true } },
      { provide: PartyService, useValue: { party: signal(null), members: signal([{ userId: 5, username: 'Ana' }]) } },
      { provide: AuthService, useValue: { user: signal({ id: 1, username: 'me' }) } },
      { provide: TranslateService, useValue: { instant: (k: string, p: { n: number }) => `${k}${p?.n ?? ''}` } },
    ],
  });
  return { karaoke: TestBed.inject(KaraokeService), received, track };
}

describe('KaraokeService', () => {
  it('scores the frames a peer sends over the channel, under that member', () => {
    const { karaoke, received } = setup();
    received.next({ userId: 5, frames: take(60) });
    const [row] = karaoke.results(doc);
    expect([row.userId, row.name, row.score]).toEqual([5, 'Ana', 10000]);
  });

  it('ignores an empty batch', () => {
    const { karaoke, received } = setup();
    received.next({ userId: 5, frames: [] });
    expect(karaoke.results(doc)).toEqual([]);
  });

  it('shows a scoreboard once, best first, and clears the take when it is dismissed', () => {
    const { karaoke, received } = setup();
    received.next({ userId: 5, frames: take(60) });
    received.next({ userId: 6, frames: take(null) });
    karaoke.finish(doc, 'Song');
    karaoke.finish(doc, 'Other');
    expect(karaoke.board()?.title).toBe('Song');
    expect(karaoke.board()?.rows.map((r) => r.userId)).toEqual([5, 6]);
    karaoke.dismissBoard();
    expect(karaoke.board()).toBeNull();
    expect(karaoke.results(doc)).toEqual([]);
    expect(karaoke.history()).toHaveLength(1);
  });

  it('calibrates from the local take, and refuses one with too few notes', () => {
    const { karaoke } = setup();
    expect(karaoke.calibrate(doc)).toBe(false);
  });
});
