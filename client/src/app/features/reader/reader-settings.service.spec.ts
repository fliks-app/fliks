import { TestBed } from '@angular/core/testing';
import { StorageScopeService } from '../../core/services/storage-scope.service';
import {
  READER_DEFAULTS,
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
    make('srv::1').save({ theme: 'light' });
    expect(make('srv::2').settings().theme).toBe(READER_DEFAULTS.theme);
    expect(make('other::1').settings().theme).toBe(READER_DEFAULTS.theme);
    expect(make('srv::1').settings().theme).toBe('light');
  });

  it('does not write while nobody is signed in', () => {
    make('srv::0', false).save({ theme: 'light' });
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

  it('accepts anything that is not an object', () => {
    expect(sanitizeReaderSettings(null)).toEqual(READER_DEFAULTS);
    expect(sanitizeReaderSettings('x')).toEqual(READER_DEFAULTS);
  });
});

describe('toReaderPreferences', () => {
  it('maps the settings onto the toolkit preferences', () => {
    const prefs = toReaderPreferences(
      { ...READER_DEFAULTS, fontFamily: 'serif', margins: 'wide', scroll: true },
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
    });
    expect(prefs.fontFamily).toContain('Georgia');
  });

  it('leaves the publisher font alone', () => {
    expect(toReaderPreferences(READER_DEFAULTS, colors).fontFamily).toBeNull();
  });
});
