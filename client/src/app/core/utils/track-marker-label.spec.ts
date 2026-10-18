import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { formatAudioLabel, formatAudioParts, formatSubtitleParts } from './player.utils';
import { buildSubtitleTracks } from './subtitle-tracks';

// Mirrors the keys of public/i18n/{en,fr}.json these labels read.
const DICT: Record<string, Record<string, string>> = {
  en: {
    'language.en': 'English', 'player.subtitle_forced': 'Forced',
    'player.track_marker.commentary': 'Commentary', 'player.track_marker.original': 'Original',
    'player.track_marker.atmos': 'Atmos', 'player.track_marker.lyrics': 'Lyrics',
  },
  fr: {
    'language.fr': 'Français', 'player.subtitle_forced': 'Forcé',
    'player.track_marker.commentary': 'Commentaire', 'player.track_marker.lyrics': 'Paroles',
    'player.track_marker.audioDescription': 'Audiodescription',
  },
};
const tr = (lang: string) =>
  ({
    instant: (key: string) => DICT[lang][key] ?? key,
    currentLang: signal(lang),
    fallbackLang: signal('en'),
  }) as unknown as TranslateService;
const EN = tr('en');
const FR = tr('fr');

describe('track marker labels', () => {
  it('lists audio markers after the codec and layout, never the stream title', () => {
    const atmos = { language: 'eng', codec: 'eac3', channels: 6, trackMarkers: ['original', 'atmos'], title: 'English DDP 5.1 Atmos' };
    expect(formatAudioParts(atmos, EN, 1)).toEqual({ head: 'English', sub: 'EAC3 • 5.1 • Original • Atmos' });
    const comm = { language: 'eng', codec: 'aac', channels: 2, trackMarkers: ['commentary'], title: 'Commentary by the director' };
    expect(formatAudioParts(comm, EN, 2).sub).toBe('AAC • 2.0 • Commentary');
    expect(formatAudioParts(comm, FR, 2).sub).toBe('AAC • 2.0 • Commentaire');
    expect(formatAudioParts({ ...comm, trackMarkers: [] }, EN, 2).sub).toBe('AAC • 2.0');
    expect(formatAudioLabel({ language: 'fre', codec: 'ac3', channels: 2, trackMarkers: ['audioDescription'] }, FR, 1))
      .toBe('Français (AC3 - 2.0 - Audiodescription)');
  });

  it('shows a subtitle title only when the track has no marker', () => {
    const sub = { language: 'eng', title: 'Commentary by the director and writers' };
    expect(formatSubtitleParts(sub, EN, 1).sub).toBe(sub.title);
    expect(formatSubtitleParts({ ...sub, trackMarkers: ['commentary'] }, EN, 1).sub).toBe('Commentary');
  });

  it('skips marker ids it has no label for', () => {
    expect(formatAudioParts({ language: 'eng', codec: 'aac', trackMarkers: ['future'] }, EN, 1).sub).toBe('AAC');
  });

  it('labels the subtitle-only markers and leaves forced and SDH to the flags', () => {
    const sub = { language: 'eng', forced: true, trackMarkers: ['forced', 'commentary', 'lyrics'] };
    expect(formatSubtitleParts(sub, EN, 1).sub).toBe('Forced • Commentary • Lyrics');
    expect(formatSubtitleParts({ ...sub, title: 'Commentaire' }, FR, 1).sub).toBe('Forcé • Commentaire • Paroles');
  });

  it('reads forced and SDH from the markers of an embedded track', () => {
    const row = { id: 1, mediaFileId: 1, language: 'fre', streamIndex: 3, codec: 'subrip' };
    const streams = [{ streamIndex: 3, title: 'Français forcés', trackMarkers: ['forced', 'hearingImpaired'] }];
    const [t] = buildSubtitleTracks([row], 1, { hideBurnIn: false, streams });
    expect([t.forced, t.hearingImpaired, t.trackMarkers]).toEqual([true, true, ['forced', 'hearingImpaired']]);
  });
});
