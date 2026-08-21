import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLibraryDto } from './create-library.dto';

/** Mirrors the global pipe (whitelist + forbidNonWhitelisted) from main.ts. */
const check = async (payload: Record<string, unknown>) => {
  const dto = plainToInstance(CreateLibraryDto, payload);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('CreateLibraryDto', () => {
  it('accepts the full payload the creation wizard sends', async () => {
    expect(
      await check({
        name: 'Movies',
        icon: 'film',
        color: 'primary',
        mediaTypes: ['movie'],
        preferredProvider: 'tmdb',
        metadataLanguage: 'fr',
        metadataRegion: 'FR',
        defaultQualityProfileId: 1,
        defaultLanguageProfileId: 2,
        isDefaultForMovies: true,
        isDefaultForSeries: false,
        path: '/medias/movies',
        userIds: [3, 5],
      }),
    ).toEqual([]);
  });

  it('rejects an unknown property', async () => {
    expect(await check({ name: 'Movies', nope: 1 })).toContain(
      'property nope should not exist',
    );
  });
});
