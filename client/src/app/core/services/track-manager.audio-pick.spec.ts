import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackManagerService } from './track-manager.service';
import { PlayerSettingsService } from './player-settings.service';
import { SubtitlesApiService } from './api/subtitles-api.service';
import { AppSettingsService } from './app-settings.service';
import { BrowserDeviceProfileService } from './browser-device-profile.service';
import { TranslateService } from '@ngx-translate/core';

/** `streamInfo.audio` order (the backend's list) — always aligned by position
 *  with the engine when it doesn't fold. */
const streams = [
  { language: 'eng', channels: 2 },
  { language: 'fra', channels: 6 },
  { language: 'fra', channels: 2 },
];

/** webOS-shaped engine tracks: one entry per LANGUAGE, folding the two
 *  French streams above into a single track — shorter than `streams`. */
const foldedTracks = [
  { id: 'audio-0', language: 'eng' },
  { id: 'audio-1', language: 'fra' },
];

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      PlayerSettingsService,
      { provide: SubtitlesApiService, useValue: {} },
      { provide: AppSettingsService, useValue: {} },
      { provide: BrowserDeviceProfileService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (k: string) => k } },
    ],
  });
  return TestBed.inject(TrackManagerService);
}

describe('TrackManagerService audio track mapping — engine folds by language', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('autoSelectAudioTrack matches the remembered stream by language, not position, when the engine folds', () => {
    const service = setup();
    vi.spyOn(service['playerSettings'], 'get').mockReturnValue(
      { rememberAudioSelections: true } as any,
    );
    // Remembered key points at streams[1] (fra:main:6) — position 1 in the
    // 3-entry streamInfo list, which is out of range against the 2-entry
    // folded engine list if read positionally.
    vi.spyOn(service['playerSettings'], 'getRememberedAudioTrack').mockReturnValue('fra:main:6');
    const selected: string[] = [];
    service.autoSelectAudioTrack(
      foldedTracks, 1, 1, null, (id) => selected.push(id), undefined, streams,
    );
    expect(selected).toEqual(['audio-1']);
  });

  it('autoSelectAudioTrack falls back to the engine tracks when streams is an empty array (not just undefined)', () => {
    const service = setup();
    vi.spyOn(service['playerSettings'], 'get').mockReturnValue(
      { rememberAudioSelections: true } as any,
    );
    vi.spyOn(service['playerSettings'], 'getRememberedAudioTrack').mockReturnValue('fra');
    const selected: string[] = [];
    // streams: [] — an offline task with no audioStreams, or no streamInfo.audio.
    service.autoSelectAudioTrack(
      foldedTracks, 1, 1, null, (id) => selected.push(id), undefined, [],
    );
    expect(selected).toEqual(['audio-1']);
  });

  it('saveAudioSelection remembers the picked track by its own language when positions do not align', () => {
    const service = setup();
    vi.spyOn(service['playerSettings'], 'get').mockReturnValue(
      { rememberAudioSelections: true } as any,
    );
    const save = vi.spyOn(service['playerSettings'], 'saveRememberedAudioTrack');
    // Picking audio-1 (folded "fra") must remember the fra:main:6 stream (by
    // language), not streams[1] read positionally — which happens to also be
    // fra:main:6 here, so use a reordered streams list to prove it is not luck.
    const reordered = [streams[1], streams[0], streams[2]]; // fra:6, eng:2, fra:2
    service.saveAudioSelection('audio-1', foldedTracks as any, 1, reordered);
    expect(save).toHaveBeenCalledWith(1, 'fr:main:6');
  });

  it('keeps positional mapping when the lists align (no folding)', () => {
    const service = setup();
    vi.spyOn(service['playerSettings'], 'get').mockReturnValue(
      { rememberAudioSelections: true } as any,
    );
    const save = vi.spyOn(service['playerSettings'], 'saveRememberedAudioTrack');
    const alignedTracks = [
      { id: 'audio-0', language: 'eng' },
      { id: 'audio-1', language: 'fra' },
      { id: 'audio-2', language: 'fra' },
    ];
    service.saveAudioSelection('audio-2', alignedTracks as any, 1, streams);
    expect(save).toHaveBeenCalledWith(1, 'fr:main:2');
  });

  it('selects nothing when the track started on is the one resolved before load', () => {
    const service = setup();
    vi.spyOn(service['playerSettings'], 'get').mockReturnValue(
      { rememberAudioSelections: true } as any,
    );
    vi.spyOn(service['playerSettings'], 'getRememberedAudioTrack').mockReturnValue('fra:main:6');
    const alignedTracks = [
      { id: 'audio-0', language: 'eng' },
      { id: 'audio-1', language: 'fra' },
      { id: 'audio-2', language: 'fra' },
    ];
    const preloadIndex = service['playerSettings'].resolveAudioStreamIndex(1, streams, 1, null);
    expect(preloadIndex).toBe(1);
    const onSelect = vi.fn();
    service.autoSelectAudioTrack(
      alignedTracks, 1, 1, `audio-${preloadIndex}`, onSelect, undefined, streams,
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
