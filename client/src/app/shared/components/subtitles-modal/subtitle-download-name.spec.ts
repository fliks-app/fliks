import { SubtitlesModalComponent } from './subtitles-modal';
import { SubtitleFileRow } from '../../../core/services/api/subtitles-api.service';

const modal = () =>
  Object.create(SubtitlesModalComponent.prototype) as unknown as {
    subtitleDownloadName: (sub: SubtitleFileRow | null) => string;
  };

const row = (over: Partial<SubtitleFileRow>): SubtitleFileRow =>
  ({ id: 1, mediaFileId: 7, language: 'fra', ...over }) as SubtitleFileRow;

describe('SubtitlesModalComponent.subtitleDownloadName', () => {
  it('uses the sidecar file name, folders stripped', () => {
    expect(
      modal().subtitleDownloadName(row({ relativePath: 'Season 01/Show - S01E01.fr.srt' })),
    ).toBe('Show - S01E01.fr.srt');
  });

  it('handles a Windows-style stored path', () => {
    expect(
      modal().subtitleDownloadName(row({ relativePath: 'Season 01\\Show - S01E01.fr.ass' })),
    ).toBe('Show - S01E01.fr.ass');
  });

  it('names an embedded track after its index and language', () => {
    expect(modal().subtitleDownloadName(row({ streamIndex: 3 }))).toBe('track-3.fra.vtt');
  });

  it('falls back to und when the track carries no language', () => {
    expect(modal().subtitleDownloadName(row({ streamIndex: 3, language: '' }))).toBe(
      'track-3.und.vtt',
    );
  });

  it('yields nothing when no row is open', () => {
    expect(modal().subtitleDownloadName(null)).toBe('');
  });
});
