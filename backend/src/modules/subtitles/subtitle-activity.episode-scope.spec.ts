import { episodeScope } from './subtitle-activity.controller';
import { SubtitleFile } from './entities/subtitle-file.entity';

const episode = (episodeNumber: number, seasonNumber: number, title: string) =>
  ({ episodeNumber, title, season: { seasonNumber } }) as never;

const subtitleFile = (over: Partial<SubtitleFile>): SubtitleFile =>
  ({ episode: null, ...over }) as SubtitleFile;

describe('episodeScope', () => {
  it('reads the subtitle row own episode link', () => {
    expect(
      episodeScope(subtitleFile({ episode: episode(3, 1, 'Pilot') })),
    ).toEqual({ seasonNumber: 1, episodeNumber: 3, episodeTitle: 'Pilot' });
  });

  it('falls back to the media file link when the row carries none', () => {
    expect(
      episodeScope(
        subtitleFile({
          mediaFile: { episode: episode(7, 2, 'Later') } as never,
        }),
      ),
    ).toEqual({ seasonNumber: 2, episodeNumber: 7, episodeTitle: 'Later' });
  });

  it('prefers the row own link over the media file one', () => {
    expect(
      episodeScope(
        subtitleFile({
          episode: episode(3, 1, 'Pilot'),
          mediaFile: { episode: episode(7, 2, 'Later') } as never,
        }),
      ).episodeNumber,
    ).toBe(3);
  });

  it('yields nulls for a movie subtitle', () => {
    expect(episodeScope(subtitleFile({ mediaFile: {} as never }))).toEqual({
      seasonNumber: null,
      episodeNumber: null,
      episodeTitle: null,
    });
  });
});
