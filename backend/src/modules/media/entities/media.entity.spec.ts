import { instanceToPlain } from 'class-transformer';
import { Media } from './media.entity';
import { Library } from '../../libraries/entities/library.entity';

/**
 * The HTTP layer serializes responses through the global
 * ClassSerializerInterceptor (class-transformer), which bypasses `toJSON` and
 * drops getters unless they are @Expose()'d. These guard that the computed
 * `path` reaches the client so the detail panel can show the media folder.
 */
describe('Media.path serialization', () => {
  function mediaWith(libPath: string | undefined, folderName: string | undefined) {
    const media = new Media();
    if (libPath !== undefined) {
      const lib = new Library();
      lib.path = libPath;
      media.library = lib;
    }
    media.folderName = folderName as string;
    return media;
  }

  it('exposes the computed path through class-transformer', () => {
    const plain = instanceToPlain(mediaWith('/medias/tvshows', 'Some Show'));
    expect(plain.path).toBe('/medias/tvshows/Some Show');
  });

  it('falls back to the library root when the media has no folder of its own', () => {
    const plain = instanceToPlain(mediaWith('/medias/tvshows', undefined));
    expect(plain.path).toBe('/medias/tvshows');
  });

  it('serializes path as null when there is no library at all', () => {
    const plain = instanceToPlain(mediaWith(undefined, undefined));
    expect(plain.path).toBeNull();
  });
});
