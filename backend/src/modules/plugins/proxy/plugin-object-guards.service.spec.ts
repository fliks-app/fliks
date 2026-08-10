import { parseObjectGuard, parsePositiveInt, PluginObjectGuardsService } from './plugin-object-guards.service';
import type { User } from '../../users/entities/user.entity';

describe('parseObjectGuard', () => {
  it('parses the two known guards', () => {
    expect(parseObjectGuard('mediaAccessible:id')).toEqual({ guard: 'mediaAccessible', paramName: 'id' });
    expect(parseObjectGuard('libraryAccessible:libraryId')).toEqual({ guard: 'libraryAccessible', paramName: 'libraryId' });
  });

  it.each([
    ['unknown guard name', 'deleteEverything:id'],
    ['no colon', 'mediaAccessible'],
    ['empty param name', 'mediaAccessible:'],
    ['too many parts', 'mediaAccessible:id:extra'],
    ['empty string', ''],
  ])('%s ("%s") -> null', (_label, spec) => {
    expect(parseObjectGuard(spec)).toBeNull();
  });
});

describe('parsePositiveInt', () => {
  it.each([
    ['1', 1],
    ['42', 42],
  ])('accepts %s -> %d', (raw, expected) => {
    expect(parsePositiveInt(raw)).toBe(expected);
  });

  it.each([
    ['0'],
    ['-1'],
    ['1.5'],
    ['1e3'],
    ['01'],
    ['0x1'],
    [' 1 '],
    [''],
    ['..'],
    ['1abc'],
    ['a/b'],
    ['1'.repeat(40)],
    ['NaN'],
    ['Infinity'],
  ])('rejects %j', (raw) => {
    expect(parsePositiveInt(raw)).toBeNull();
  });
});

function fakeUser(): User {
  return { id: 7 } as User;
}

describe('PluginObjectGuardsService.check', () => {
  function makeService(accessibleLibraryIds: number[]) {
    const libraries = { getAccessibleLibraryIds: jest.fn().mockResolvedValue(accessibleLibraryIds) };
    const mediaService = { assertAccessible: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = { get: jest.fn().mockReturnValue(mediaService) };
    const service = new PluginObjectGuardsService(libraries as never, moduleRef as never);
    return { service, libraries, mediaService };
  }

  it('libraryAccessible: true when the id is in the accessible set', async () => {
    const { service, libraries } = makeService([1, 2, 3]);
    await expect(service.check('libraryAccessible', '2', fakeUser())).resolves.toBe(true);
    expect(libraries.getAccessibleLibraryIds).toHaveBeenCalledTimes(1);
  });

  it('libraryAccessible: false when the id is not in the accessible set', async () => {
    const { service } = makeService([1, 2, 3]);
    await expect(service.check('libraryAccessible', '99', fakeUser())).resolves.toBe(false);
  });

  it('mediaAccessible: true when MediaService.assertAccessible does not throw', async () => {
    const { service, mediaService } = makeService([1]);
    await expect(service.check('mediaAccessible', '55', fakeUser())).resolves.toBe(true);
    expect(mediaService.assertAccessible).toHaveBeenCalledWith(55, [1]);
  });

  it('mediaAccessible: false when MediaService.assertAccessible throws', async () => {
    const { service, mediaService } = makeService([1]);
    mediaService.assertAccessible.mockRejectedValue(new Error('not found'));
    await expect(service.check('mediaAccessible', '55', fakeUser())).resolves.toBe(false);
  });

  it.each(['0', '-1', '1.5', '01', '..', 'a/b', '1abc', ''])(
    'never calls LibrariesService or MediaService for a rejected raw value %j',
    async (raw) => {
      const { service, libraries, mediaService } = makeService([1]);
      await expect(service.check('mediaAccessible', raw, fakeUser())).resolves.toBe(false);
      expect(libraries.getAccessibleLibraryIds).not.toHaveBeenCalled();
      expect(mediaService.assertAccessible).not.toHaveBeenCalled();
    },
  );
});
