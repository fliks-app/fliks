import { LibrariesService } from './libraries.service';
import { Library } from './entities/library.entity';

describe('LibrariesService.remove', () => {
  it('removes every media row of the library, keeps the files, then the library', async () => {
    const lib = { id: 5, name: 'Movies' } as Library;
    const removedMedia: number[] = [];
    const removedLibs: Library[] = [];

    const repo = {
      findOne: async () => lib,
      remove: async (l: Library) => {
        removedLibs.push(l);
      },
    };
    const mediaRepo = { find: async () => [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const mediaService = {
      remove: async (id: number) => {
        removedMedia.push(id);
        // The disk path is returned for the caller to delete — ignoring it is
        // what keeps the files on disk.
        return { title: `m${id}`, diskPath: `/medias/m${id}` };
      },
    };

    const service = new LibrariesService(
      repo as never,
      {} as never,
      mediaRepo as never,
      {} as never,
      { get: () => mediaService } as never,
    );

    await service.remove(5);

    expect(removedMedia).toEqual([1, 2, 3]);
    expect(removedLibs).toEqual([lib]);
  });

  it('throws when the library does not exist', async () => {
    const repo = { findOne: async () => null };
    const service = new LibrariesService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.remove(9)).rejects.toThrow('Library #9 not found');
  });
});
