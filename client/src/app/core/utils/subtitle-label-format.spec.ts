import { formatSubtitleLabel, formatSubtitleParts } from './player.utils';
import { signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

/** Key-echoing stub. An unresolved key falls through to the platform's own
 *  language name, so the locale signals have to be there too. */
const translate = {
  instant: (key: string) => key,
  currentLang: signal('en'),
  fallbackLang: signal('en'),
} as unknown as TranslateService;

const srt = { language: 'fra', codec: 'subrip', forced: true };

describe('subtitle label file format', () => {
  it('omits the format unless asked', () => {
    expect(formatSubtitleLabel(srt, translate)).not.toContain('SRT');
    expect(formatSubtitleParts(srt, translate).sub).not.toContain('SRT');
  });

  it('spells the format out when asked', () => {
    const opts = { showFormat: true };
    expect(formatSubtitleLabel(srt, translate, undefined, opts)).toContain(
      'SRT',
    );
    expect(formatSubtitleParts(srt, translate, undefined, opts).sub).toContain(
      'SRT',
    );
  });

  it('keeps the other flags either way', () => {
    expect(formatSubtitleLabel(srt, translate)).toContain(
      'player.subtitle_forced',
    );
    expect(formatSubtitleParts(srt, translate).sub).toContain(
      'player.subtitle_forced',
    );
  });

  it('numbers a track the file left untagged', () => {
    const untagged = { codec: 'subrip' };
    expect(formatSubtitleLabel(untagged, translate, 3)).toContain(
      'player.subtitle_track_n',
    );
    expect(formatSubtitleParts(untagged, translate, 3).head).toContain(
      'player.subtitle_track_n',
    );
  });

  it('keeps the language name when the track has one', () => {
    expect(formatSubtitleParts(srt, translate, 3).head).not.toContain(
      'player.subtitle_track_n',
    );
  });

  it('falls back to the bare code when no number is supplied', () => {
    expect(formatSubtitleParts({ codec: 'subrip' }, translate).head).toBe('und');
  });

  it('derives the format from the file extension when the codec is absent', () => {
    const byPath = { language: 'eng', relativePath: 'Show.S01E01.en.vtt' };
    expect(
      formatSubtitleLabel(byPath, translate, undefined, { showFormat: true }),
    ).toContain('VTT');
    expect(formatSubtitleLabel(byPath, translate)).not.toContain('VTT');
  });
});

describe('subtitle label stream title', () => {
  const spa = { language: 'spa', codec: 'subrip' };
  const showFormat = { showFormat: true };

  it('puts the title ahead of the format in the subline and the label', () => {
    const sub = { ...spa, title: 'Latin American' };
    expect(formatSubtitleParts(sub, translate, 1, showFormat).sub).toBe('Latin American • SRT');
    expect(formatSubtitleLabel(sub, translate, 1, showFormat)).toContain('(Latin American) (SRT)');
  });

  it('tells two tracks of one language apart', () => {
    const labels = [{ ...spa, title: 'Latin American' }, spa].map(
      (s) => formatSubtitleParts(s, translate, 1).sub,
    );
    expect(labels).toEqual(['Latin American', '']);
  });

  it('drops a title that is empty, or the language name or code', () => {
    for (const title of [undefined, null, '  ', 'spa', 'SPA', 'es', 'Spanish']) {
      expect(formatSubtitleParts({ ...spa, title }, translate, 1).sub).toBe('');
    }
  });

  it('drops a title that only restates a flag already shown', () => {
    expect(formatSubtitleParts({ ...spa, forced: true, title: 'Forced' }, translate).sub).toBe(
      'player.subtitle_forced',
    );
    expect(
      formatSubtitleParts({ ...spa, hearingImpaired: true, title: 'SDH' }, translate).sub,
    ).toBe('player.subtitle_hearing_impaired');
  });

  it('keeps such a title when the flag is not set', () => {
    expect(formatSubtitleParts({ ...spa, title: 'Forced' }, translate).sub).toBe('Forced');
  });
});
