import { formatSubtitleLabel, formatSubtitleParts } from './player.utils';
import { TranslateService } from '@ngx-translate/core';

/** The formatters only ever call `instant`, so a key-echoing stub is enough. */
const translate = { instant: (key: string) => key } as TranslateService;

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

  it('derives the format from the file extension when the codec is absent', () => {
    const byPath = { language: 'eng', relativePath: 'Show.S01E01.en.vtt' };
    expect(
      formatSubtitleLabel(byPath, translate, undefined, { showFormat: true }),
    ).toContain('VTT');
    expect(formatSubtitleLabel(byPath, translate)).not.toContain('VTT');
  });
});
