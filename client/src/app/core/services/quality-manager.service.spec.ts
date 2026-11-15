import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerSettingsService } from './player-settings.service';
import { ServerConfigService } from './server-config.service';
import { BEST_QUALITY_ID, highestRungId, QualityManagerService, type QualityOption } from './quality-manager.service';

const opt = (id: string, height: number): QualityOption => ({ id, label: id, height });

describe('highestRungId', () => {
  it('picks the first rung of the backend order, excluding auto', () => {
    const opts = [opt('auto', 0), opt('2160p', 2160), opt('1080p', 1080), opt('480p', 480)];
    expect(highestRungId(opts)).toBe('2160p');
  });

  it('keeps a scope original above its taller eco rung', () => {
    const opts = [opt('auto', 0), opt('original', 818), { ...opt('eco-1080p', 1080), lowBandwidth: true }];
    expect(highestRungId(opts)).toBe('original');
  });

  it('returns undefined for an empty list', () => {
    expect(highestRungId([])).toBeUndefined();
  });

  it('returns undefined when only auto is present', () => {
    expect(highestRungId([opt('auto', 0)])).toBeUndefined();
  });
});

describe('QualityManagerService preference', () => {
  const ladder = (ids: [string, number][]) => ({
    playMethod: 'Transcode',
    videoCopyStream: false,
    source: {},
    qualities: ids.map(([id, height]) => ({ id, label: id, height })),
  });
  const fourK = ladder([['2160p', 2160], ['1080p', 1080], ['720p', 720]]);
  const only720 = ladder([['720p', 720], ['480p', 480]]);
  const stored = () => JSON.parse(localStorage.getItem('player.qualityId') ?? 'null');

  function setup() {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        { provide: PlayerSettingsService, useValue: { get: () => ({ showEcoQualities: true }) } },
      ],
    });
    return TestBed.inject(QualityManagerService);
  }
  const pick = (qm: QualityManagerService, id: string) =>
    qm.persistPreference(qm.availableQualities().find((q) => q.id === id)!);

  afterEach(() => TestBed.resetTestingModule());

  it('remembers the top rung as best, restored for the engine to resolve on a 4K title', () => {
    const qm = setup();
    qm.buildQualityOptions(only720);
    pick(qm, '720p');
    expect(stored()).toEqual({ id: 'best' });
    qm.restorePreference();
    expect(qm.activeQualityId()).toBe(BEST_QUALITY_ID);
    qm.buildQualityOptions(fourK);
    qm.adoptNegotiatedQuality('auto');
    expect(qm.activeQualityId()).toBe('2160p');
  });

  it('restores best on a 720p-only title as the rung served there', () => {
    const qm = setup();
    qm.buildQualityOptions(fourK);
    pick(qm, '2160p');
    qm.restorePreference();
    expect(qm.activeQualityId()).toBe(BEST_QUALITY_ID);
    qm.buildQualityOptions(only720);
    qm.adoptNegotiatedQuality('auto');
    expect(qm.activeQualityId()).toBe('720p');
  });

  it('locks a restored best to the top rung with ABR off, like an explicit pick', () => {
    const qm = setup();
    localStorage.setItem('player.qualityId', JSON.stringify({ id: 'best' }));
    qm.restorePreference();
    qm.buildQualityOptions(fourK);
    qm.adoptNegotiatedQuality('auto');
    const configure = vi.fn();
    const selectVariantTrack = vi.fn();
    const tracks = [{ id: 1, height: 2160, originalVideoId: '/2160p/' }, { id: 2, height: 1080, originalVideoId: '/1080p/' }];
    const engine = { configure, selectVariantTrack, getVariantTracks: () => tracks, paused: false } as never;
    qm.applyQualityPreferenceAfterLoad(engine, 'transcode');
    expect(configure).toHaveBeenCalledWith({ abr: { enabled: false } });
    expect(selectVariantTrack).toHaveBeenCalledWith(tracks[0], true);
  });

  it('adopts the served rung once best is resolved', () => {
    const qm = setup();
    qm.buildQualityOptions(fourK);
    qm.adoptNegotiatedQuality('1080p');
    expect(qm.activeQualityId()).toBe('1080p');
  });

  it('keeps a pick below the top as a literal rung', () => {
    const qm = setup();
    qm.buildQualityOptions(fourK);
    pick(qm, '720p');
    expect(stored()).toEqual({ id: '720p' });
    qm.restorePreference();
    expect(qm.activeQualityId()).toBe('720p');
  });

  it('reads a stored literal rung from before best existed', () => {
    const qm = setup();
    localStorage.setItem('player.qualityId', JSON.stringify({ id: '1080p' }));
    qm.restorePreference();
    expect(qm.activeQualityId()).toBe('1080p');
  });
});

describe('QualityManagerService start bandwidth estimate', () => {
  let server = 'https://a.example';
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: TranslateService, useValue: { instant: (k: string) => k } },
        { provide: PlayerSettingsService, useValue: { get: () => ({ showEcoQualities: true }) } },
        { provide: ServerConfigService, useValue: { serverUrl: () => server } },
      ],
    });
    return TestBed.inject(QualityManagerService);
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    server = 'https://a.example';
  });

  it('seeds 100 Mbps until a measurement is stored, then the measurement, per server', () => {
    const qm = setup();
    expect(qm.startBandwidthEstimate()).toBe(100_000_000);
    qm.rememberBandwidth(2_000_000);
    qm.rememberBandwidth(null);
    qm.rememberBandwidth(Number.NaN);
    expect(qm.startBandwidthEstimate()).toBe(2_000_000);
    server = 'https://b.example';
    expect(qm.startBandwidthEstimate()).toBe(100_000_000);
  });

  it('passes the stored estimate to the engine on auto', () => {
    const qm = setup();
    qm.rememberBandwidth(3_000_000);
    const configure = vi.fn();
    qm.selectQuality({ id: 'auto', label: 'Auto', height: 0 }, { configure } as never, 'transcode', true);
    expect(configure.mock.calls[0][0].abr.defaultBandwidthEstimate).toBe(3_000_000);
  });
});
