import { CountsService } from './counts.service';
import type { User } from '../users/entities/user.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { Media } from '../media/entities/media.entity';
import { Action } from '../auth/casl/actions.enum';

describe('CountsService.getCounts', () => {
  const user = { id: 7 } as User;

  function make(opts: {
    canReadDownloadClient: boolean;
    canManageRequests: boolean;
    canReadMedia?: boolean;
  }) {
    const historyRepo = { count: jest.fn().mockResolvedValue(3) };
    const requestRepo = { count: jest.fn().mockResolvedValue(5) };
    const ability = {
      can: jest.fn((action: Action, subject: unknown) => {
        if (subject === Media && action === Action.Track)
          return opts.canReadDownloadClient;
        if (subject === FliksRequest) return opts.canManageRequests;
        if (subject === Media) return opts.canReadMedia ?? true;
        return false;
      }),
    };
    const caslAbilityFactory = { createForUser: jest.fn().mockReturnValue(ability) };
    const mediaService = {
      getCountsByLibrary: jest.fn().mockResolvedValue({ 1: 10, 2: 20 }),
    };
    const libraries = {
      getAccessibleLibraryIds: jest.fn().mockResolvedValue([1, 2]),
    };
    const service = new CountsService(
      historyRepo as never,
      requestRepo as never,
      caslAbilityFactory as never,
      mediaService as never,
      libraries as never,
    );
    return { service, historyRepo, requestRepo, mediaService, libraries };
  }

  it('counts active queue rows for a user who can read download clients', async () => {
    const { service, historyRepo } = make({
      canReadDownloadClient: true,
      canManageRequests: false,
    });
    const counts = await service.getCounts(user);
    expect(counts.queueActive).toBe(3);
    const where = historyRepo.count.mock.calls[0][0].where as {
      status: { value: string[] };
    };
    expect(where.status.value).toEqual(['grabbed', 'importing']);
  });

  it('returns 0 queue items without the download-clients read ability, without querying', async () => {
    const { service, historyRepo } = make({
      canReadDownloadClient: false,
      canManageRequests: false,
    });
    const counts = await service.getCounts(user);
    expect(counts.queueActive).toBe(0);
    expect(historyRepo.count).not.toHaveBeenCalled();
  });

  it('scopes pending requests to the user when they cannot manage requests', async () => {
    const { service, requestRepo } = make({
      canReadDownloadClient: true,
      canManageRequests: false,
    });
    await service.getCounts(user);
    expect(requestRepo.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ user: { id: 7 } }) as object,
    });
  });

  it('counts all pending requests for a manager', async () => {
    const { service, requestRepo } = make({
      canReadDownloadClient: true,
      canManageRequests: true,
    });
    await service.getCounts(user);
    const where = requestRepo.count.mock.calls[0][0].where as object;
    expect(where).not.toHaveProperty('user');
  });

  it('passes the accessible library ids through to the media counts', async () => {
    const { service, mediaService, libraries } = make({
      canReadDownloadClient: true,
      canManageRequests: false,
    });
    const counts = await service.getCounts(user);
    expect(libraries.getAccessibleLibraryIds).toHaveBeenCalledWith(user);
    expect(mediaService.getCountsByLibrary).toHaveBeenCalledWith([1, 2]);
    expect(counts.mediaByLibrary).toEqual({ 1: 10, 2: 20 });
  });

  it('returns empty media counts without the media read ability, without querying', async () => {
    const { service, mediaService, libraries } = make({
      canReadDownloadClient: true,
      canManageRequests: false,
      canReadMedia: false,
    });
    const counts = await service.getCounts(user);
    expect(counts.mediaByLibrary).toEqual({});
    expect(libraries.getAccessibleLibraryIds).not.toHaveBeenCalled();
    expect(mediaService.getCountsByLibrary).not.toHaveBeenCalled();
  });
});
