import { BadRequestException } from '@nestjs/common';
import { ProfilesService } from './profiles.service';

/** Profiles ids 1, 2, 3 exist; the first by id is 1. */
function repo() {
  const ids = [1, 2, 3];
  return {
    findOne: ({ where: { id } }: { where: { id: number } }) =>
      Promise.resolve(ids.includes(id) ? { id } : null),
    find: () => Promise.resolve([{ id: ids[0] }]),
  };
}

describe('ProfilesService import profile resolution', () => {
  const service = new ProfilesService(repo() as never, repo() as never);
  const resolvers = [
    ['quality', service.resolveQualityProfileIdForImport.bind(service)],
    ['language', service.resolveLanguageProfileIdForImport.bind(service)],
  ] as const;

  describe.each(resolvers)('%s', (_kind, resolve) => {
    it('keeps an explicit profile over the library default', async () => {
      await expect(resolve(3, 2)).resolves.toBe(3);
    });

    it('uses the library default when none is requested', async () => {
      await expect(resolve(undefined, 2)).resolves.toBe(2);
    });

    it('falls back to the first profile without a library default', async () => {
      await expect(resolve(undefined, null)).resolves.toBe(1);
    });

    it('falls back to the first profile when the library default is gone', async () => {
      await expect(resolve(undefined, 99)).resolves.toBe(1);
    });

    it('rejects an explicit profile that does not exist', async () => {
      await expect(resolve(99, 2)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
