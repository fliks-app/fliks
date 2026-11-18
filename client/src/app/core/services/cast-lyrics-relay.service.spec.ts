import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LyricsApiService } from './api/lyrics-api.service';
import { AudioPlayerService } from './audio-player/audio-player.service';
import { CastLyricsRelayService } from './cast-lyrics-relay.service';
import { CastService } from './cast.service';
import { KaraokeService } from './karaoke/karaoke.service';

const main = (id: number, cued: boolean) => ({
  id, kind: 'main', lang: 'und', synced: true, offset: 0, source: 'sidecar',
  line: [{ start: 0, value: 'plain' }],
  ...(cued ? { cueLine: [{ index: 0, start: 0, end: 1, value: 'cued', cue: [] }] } : {}),
});

describe('CastLyricsRelayService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sends the word-synced document with the stage flag while the karaoke view is open, whatever the stem mode', async () => {
    const stage = signal(true);
    const sent: Array<{ kind: string; data?: string }> = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: LyricsApiService, useValue: { get: async () => ({ structuredLyrics: [main(1, false), main(2, true)] }) } },
        { provide: AudioPlayerService, useValue: { musicMode: signal(true), track: signal({ itemId: 7 }), stemMode: signal('original') } },
        { provide: CastService, useValue: { isConnected: signal(true), sendFliks: (m: never) => sent.push(m) } },
        { provide: KaraokeService, useValue: { stage } },
      ],
    });
    TestBed.inject(CastLyricsRelayService);
    TestBed.tick();
    await vi.waitFor(() => expect(sent.some((m) => m.kind === 'lyrics')).toBe(true));
    const first = sent.find((m) => m.kind === 'lyrics')!;
    expect(JSON.parse(first.data!)).toMatchObject({ stage: true, rows: [{ text: 'cued' }] });
  });
});
