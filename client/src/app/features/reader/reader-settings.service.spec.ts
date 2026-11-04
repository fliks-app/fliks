import { TestBed } from '@angular/core/testing';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import {
  READER_DEFAULTS,
  THEME_PRESETS,
  presetPatch,
  resetPatch,
  ReaderSettingsService,
  sanitizeReaderSettings,
  toReaderPreferences,
} from './reader-settings.service';

const colors = { background: '#111', text: '#eee', link: '#88f' };

const make = (suffix = 'srv::1', canPersist = true): ReaderSettingsService => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      ReaderSettingsService,
      { provide: StorageScopeService, useValue: { suffix: () => suffix, canPersist: () => canPersist } },
    ],
  });
  return TestBed.inject(ReaderSettingsService);
};

describe('ReaderSettingsService', () => {
  beforeEach(() => localStorage.clear());

  it('starts from the defaults for a user with nothing stored', () => {
    expect(make().settings()).toEqual(READER_DEFAULTS);
  });

  it('remembers a saved change on the next opening', () => {
    make().save({ fontSize: 1.4, theme: 'sepia', scroll: true });
    expect(make().settings()).toEqual({ ...READER_DEFAULTS, fontSize: 1.4, theme: 'sepia', scroll: true });
  });

  it('keeps each user and server apart', () => {
    make('srv::1').save({ theme: 'original' });
    expect(make('srv::2').settings().theme).toBe(READER_DEFAULTS.theme);
    expect(make('other::1').settings().theme).toBe(READER_DEFAULTS.theme);
    expect(make('srv::1').settings().theme).toBe('original');
  });

  it('does not write while nobody is signed in', () => {
    make('srv::0', false).save({ theme: 'original' });
    expect(localStorage.length).toBe(0);
  });

  it('falls back to the defaults on a corrupt blob', () => {
    localStorage.setItem('reader.settings:srv::1', '{not json');
    expect(make().settings()).toEqual(READER_DEFAULTS);
  });

  it('survives storage that throws, on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const svc = make();
    expect(svc.settings()).toEqual(READER_DEFAULTS);
    svc.save({ fontSize: 1.2 });
    expect(svc.settings().fontSize).toBe(1.2);
  });
});

describe('sanitizeReaderSettings', () => {
  it('drops each wrong field to its default and keeps the good ones', () => {
    expect(
      sanitizeReaderSettings({
        fontSize: 'big',
        fontFamily: 'comic',
        theme: 'sepia',
        lineHeight: 1.8,
        margins: null,
        scroll: 'yes',
      }),
    ).toEqual({ ...READER_DEFAULTS, theme: 'sepia', lineHeight: 1.8 });
  });

  it('clamps numbers into their range', () => {
    const s = sanitizeReaderSettings({ fontSize: 99, lineHeight: -3 });
    expect(s.fontSize).toBe(2);
    expect(s.lineHeight).toBe(1.2);
  });

  it('reads the values stored before the presets', () => {
    expect(sanitizeReaderSettings({ theme: 'light', fontFamily: 'serif' })).toMatchObject({ theme: 'original', fontFamily: 'literata' });
    expect(sanitizeReaderSettings({ theme: 'dark' }).theme).toBe('night');
  });

  it('accepts anything that is not an object', () => {
    expect(sanitizeReaderSettings(null)).toEqual(READER_DEFAULTS);
    expect(sanitizeReaderSettings('x')).toEqual(READER_DEFAULTS);
  });
});

describe('toReaderPreferences', () => {
  it('maps the settings onto the toolkit preferences', () => {
    const prefs = toReaderPreferences(
      { ...READER_DEFAULTS, fontFamily: 'literata', margins: 'wide', scroll: true },
      colors,
    );
    expect(prefs).toMatchObject({
      fontSize: 1,
      lineHeight: 1.5,
      scroll: true,
      pageGutter: 64,
      scrollPaddingLeft: 64,
      scrollPaddingRight: 64,
      backgroundColor: '#111',
      textColor: '#eee',
      selectionTextColor: '#eee',
    });
    expect(prefs.fontFamily).toContain('Literata');
  });

  it('halves the side margins on a phone-width reader', () => {
    expect(toReaderPreferences({ ...READER_DEFAULTS, margins: 'wide' }, colors, true)).toMatchObject({
      pageGutter: 32,
      scrollPaddingLeft: 32,
      scrollPaddingRight: 32,
    });
  });

  it('sets the columns and the justification only when asked', () => {
    expect(toReaderPreferences(READER_DEFAULTS, colors)).toMatchObject({ columnCount: null, textAlign: null, hyphens: null });
    expect(toReaderPreferences({ ...READER_DEFAULTS, columns: '2', justify: true }, colors)).toMatchObject({
      columnCount: 2,
      textAlign: 'justify',
      hyphens: true,
    });
  });

  it('a preset carries its colours, font and line height', () => {
    expect(presetPatch('sepia')).toEqual({ theme: 'sepia', fontFamily: THEME_PRESETS.sepia.fontFamily, lineHeight: THEME_PRESETS.sepia.lineHeight });
  });

  it('leaves the publisher font alone', () => {
    expect(toReaderPreferences(READER_DEFAULTS, colors).fontFamily).toBeNull();
  });
});

describe('ReaderSettingsService comic prefs', () => {
  beforeEach(() => localStorage.clear());

  it('remembers the layout of each volume apart', () => {
    const s = make();
    s.saveComicPrefs(1, { mode: 'manga', spread: true });
    s.saveComicPrefs(2, { mode: 'webtoon', spread: false });
    expect(make().comicPrefs(1)).toEqual({ mode: 'manga', spread: true });
    expect(make().comicPrefs(2)).toEqual({ mode: 'webtoon', spread: false });
    expect(make().comicPrefs(3)).toEqual({ mode: 'paged', spread: false });
  });

  it('falls back to paged on a corrupt stored mode', () => {
    localStorage.setItem('reader.comics:srv::1', JSON.stringify({ 1: { mode: 'sideways', spread: 3 } }));
    expect(make().comicPrefs(1)).toEqual({ mode: 'paged', spread: false });
  });
});

describe('resetPatch', () => {
  it('keeps the theme with its own preset and restores the layout defaults', () => {
    const patch = resetPatch('sepia');
    expect(patch).toMatchObject({ ...presetPatch('sepia') });
    expect(patch).toMatchObject({
      fontSize: READER_DEFAULTS.fontSize,
      margins: READER_DEFAULTS.margins,
      columns: READER_DEFAULTS.columns,
      justify: READER_DEFAULTS.justify,
    });
    expect(patch.theme).toBe('sepia');
    expect(patch).not.toHaveProperty('zoom');
  });
});
