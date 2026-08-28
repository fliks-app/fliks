import { SseAudienceService } from './sse-audience.service';

/**
 * `viewersForMedia` is the audience for download progress: passive page state
 * the whole household sees, unlike `recipientsForMedia`'s requester-scoped
 * toasts. It must mirror LibrariesService' access rule — admins and `manage:all`
 * see every library, everyone else needs a grant on the media's own library.
 */
describe('SseAudienceService.viewersForMedia', () => {
  const user = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
    id,
    isAdmin: false,
    enabled: true,
    permissions: [],
    ...over,
  });

  function makeService(opts: {
    users: unknown[];
    libraryId: number | null;
    grantedUserIds: number[];
  }) {
    const mediaRepo = {
      findOne: jest.fn(async () => ({
        id: 1,
        library: opts.libraryId == null ? null : { id: opts.libraryId },
      })),
    };
    const userRepo = { find: jest.fn(async () => opts.users) };
    const accessRepo = {
      find: jest.fn(async () => opts.grantedUserIds.map((id) => ({ userId: id }))),
    };
    return new SseAudienceService(
      {} as never,
      userRepo as never,
      mediaRepo as never,
      accessRepo as never,
    );
  }

  it('includes a granted user who never requested the media', async () => {
    const service = makeService({
      users: [user(1), user(2)],
      libraryId: 7,
      grantedUserIds: [2],
    });
    await expect(service.viewersForMedia(1)).resolves.toEqual([2]);
  });

  it('always includes admins and manage:all, grant or not', async () => {
    const service = makeService({
      users: [
        user(1, { isAdmin: true }),
        user(2, { permissions: ['manage:all'] }),
        user(3),
      ],
      libraryId: 7,
      grantedUserIds: [],
    });
    await expect(service.viewersForMedia(1)).resolves.toEqual([1, 2]);
  });

  it('falls back to full-library users when the media has no library', async () => {
    const service = makeService({
      users: [user(1, { isAdmin: true }), user(2)],
      libraryId: null,
      grantedUserIds: [2],
    });
    await expect(service.viewersForMedia(1)).resolves.toEqual([1]);
  });
});
