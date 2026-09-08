import { TestBed } from '@angular/core/testing';
import { PlayerSettingsService, type PlayerSettings } from './player-settings.service';
import { DeviceService } from './device.service';

/** ffprobe reports 3-letter codes; TMDB's original language is 2-letter. */
const STREAMS = [{ language: 'fra' }, { language: 'jpn' }, { language: 'eng' }];
const FLAGGED = [
  { language: 'fra' },
  { language: 'jpn', isDefault: true },
  { language: 'eng' },
];

const make = (patch: Partial<PlayerSettings> = {}): PlayerSettingsService => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: DeviceService, useValue: { isTv: () => false } as unknown as DeviceService },
    ],
  });
  const svc = TestBed.inject(PlayerSettingsService);
  svc.patch(patch);
  return svc;
};

describe('PlayerSettingsService audio selection', () => {
  beforeEach(() => localStorage.clear());

  it('picks the preferred language in `preferred` mode', () => {
    const svc = make({ audioSelectionMode: 'preferred', preferredAudioLanguage: 'eng' });
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, 'ja')).toBe(2);
  });

  it('picks the title language in `original` mode, normalizing 2-letter codes', () => {
    const svc = make({ audioSelectionMode: 'original', preferredAudioLanguage: 'fra' });
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, 'ja')).toBe(1);
  });

  it('ignores the preferred language in `original` mode', () => {
    const svc = make({ audioSelectionMode: 'original', preferredAudioLanguage: 'eng' });
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, 'ko')).toBe(0);
  });

  it('falls back to the first track for a title with no known language', () => {
    const svc = make({ audioSelectionMode: 'original', preferredAudioLanguage: 'eng' });
    expect(svc.audioLanguage(null)).toBeUndefined();
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, null)).toBe(0);
  });

  it('picks the flagged track in `default` mode, ignoring both languages', () => {
    const svc = make({ audioSelectionMode: 'default', preferredAudioLanguage: 'eng' });
    expect(svc.audioLanguage('ja')).toBeUndefined();
    expect(svc.resolveAudioStreamIndex(1, FLAGGED, 1, 'ja')).toBe(1);
  });

  it('falls back to the first track when the file flags no default', () => {
    const svc = make({ audioSelectionMode: 'default', preferredAudioLanguage: 'eng' });
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, 'ja')).toBe(0);
  });

  it('takes the first track in `first` mode, flagged default and all', () => {
    const svc = make({ audioSelectionMode: 'first', preferredAudioLanguage: 'eng' });
    expect(svc.audioLanguage('ja')).toBeUndefined();
    expect(svc.resolveAudioStreamIndex(1, FLAGGED, 1, 'ja')).toBe(0);
  });

  it('falls back to the first track when no requested language is present', () => {
    const svc = make({ audioSelectionMode: 'preferred', preferredAudioLanguage: 'kor' });
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, 'ko')).toBe(0);
  });

  it('selects nothing on a file with no audio at all', () => {
    const svc = make({ audioSelectionMode: 'first' });
    expect(svc.resolveAudioStreamIndex(1, [], 1, 'ja')).toBeUndefined();
  });

  it('lets a remembered choice win over every mode', () => {
    const svc = make({ audioSelectionMode: 'default', rememberAudioSelections: true });
    svc.saveRememberedAudioTrack(1, 'eng');
    expect(svc.resolveAudioStreamIndex(1, STREAMS, 1, 'ja')).toBe(2);
    expect(svc.resolveAudioLanguage(1, 'ja')).toBe('eng');
  });

  it('leaves the file default alone on a fresh install', () => {
    expect(make().get().audioSelectionMode).toBe('default');
  });

  // A profile predating the mode keeps its behaviour either way: the flag is
  // the only record of it, and `default` is now what a fresh install gets.
  it.each([
    [true, 'default'],
    [false, 'preferred'],
  ])('migrates useDefaultAudioStream %s to %s', (flag, mode) => {
    localStorage.setItem(
      'player.settings',
      JSON.stringify({ useDefaultAudioStream: flag, preferredAudioLanguage: 'eng' }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: DeviceService, useValue: { isTv: () => false } as unknown as DeviceService },
      ],
    });
    expect(TestBed.inject(PlayerSettingsService).get().audioSelectionMode).toBe(mode);
  });

  /** The settings picker stores ISO 639-1; ffprobe reports either 639-2 form,
   *  and `fre` is the one that never equalled `fra`. */
  it('matches a stream whichever ISO form it carries', () => {
    const svc = make({ audioSelectionMode: 'preferred', preferredAudioLanguage: 'fr' });
    expect(svc.resolveAudioStreamIndex(1, [{ language: 'eng' }, { language: 'fre' }], 1, null))
      .toBe(1);
  });

  it('folds a preference stored by an older build', () => {
    localStorage.setItem(
      'player.settings',
      JSON.stringify({ preferredAudioLanguage: 'fra', preferredSubtitleLanguage: 'jpn' }),
    );
    const svc = make();
    expect(svc.get().preferredAudioLanguage).toBe('fr');
    expect(svc.get().preferredSubtitleLanguage).toBe('ja');
  });

  it('leaves "no preference" empty rather than folding it to und', () => {
    localStorage.setItem('player.settings', JSON.stringify({ preferredAudioLanguage: '' }));
    expect(make().get().preferredAudioLanguage).toBe('');
  });
});
