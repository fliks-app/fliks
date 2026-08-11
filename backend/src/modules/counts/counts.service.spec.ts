import { CountsService } from './counts.service';
import type { User } from '../users/entities/user.entity';
import { FliksRequest } from '../requests/entities/request.entity';
import { Media } from '../media/entities/media.entity';
import { Action } from '../auth/casl/actions.enum';
import { PluginCountsCacheService } from '../plugins/host/plugin-counts-cache.service';

describe('CountsService.getCounts', () => {
  const user = { id: 7 } as User;

  function make(opts: { canManageRequests: boolean; canReadMedia?: boolean }) {
    const requestRepo = { count: jest.fn().mockResolvedValue(5) };
    const ability = {
      can: jest.fn((action: Action, subject: unknown) => {
        if (subject === FliksRequest) return opts.canManageRequests;
        if (subject === Media) return opts.canReadMedia ?? true;
        return false;
      }),
    };
    const caslAbilityFactory = {
      createForUser: jest.fn().mockReturnValue(ability),
    };
    const mediaService = {
      getCountsByLibrary: jest.fn().mockResolvedValue({ 1: 10, 2: 20 }),
    };
    const libraries = {
      getAccessibleLibraryIds: jest.fn().mockResolvedValue([1, 2]),
    };
    const pluginCounts = new PluginCountsCacheService();
    const service = new CountsService(
      requestRepo as never,
      caslAbilityFactory as never,
      mediaService as never,
      libraries as never,
      pluginCounts,
    );
    return { service, requestRepo, mediaService, libraries, pluginCounts };
  }

  it('leaves the queue badge absent from the map when no publisher ever pushed it', async () => {
    const { service, pluginCounts } = make({ canManageRequests: false });
    const counts = await service.getCounts(user);
    expect(counts.badgeCounts).not.toHaveProperty('queueActive');
    expect(pluginCounts.has('queueActive')).toBe(false);
  });

  it('reflects a value pushed to the shared cache, with no cache mock in the way', async () => {
    const { service, pluginCounts } = make({ canManageRequests: false });
    pluginCounts.set('queueActive', 4);
    const counts = await service.getCounts(user);
    expect(counts.badgeCounts.queueActive).toBe(4);
  });

  it('hides a pushed queue count from a user who may not see the queue — absent, not 0', async () => {
    const { service, pluginCounts } = make({
      canManageRequests: false,
      canReadMedia: false,
    });
    pluginCounts.set('queueActive', 4);
    const counts = await service.getCounts(user);
    expect(counts.badgeCounts).not.toHaveProperty('queueActive');
  });

  it('scopes pending requests to the user when they cannot manage requests', async () => {
    const { service, requestRepo } = make({ canManageRequests: false });
    await service.getCounts(user);
    expect(requestRepo.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ user: { id: 7 } }) as object,
    });
  });

  it('counts all pending requests for a manager', async () => {
    const { service, requestRepo } = make({ canManageRequests: true });
    await service.getCounts(user);
    const where = requestRepo.count.mock.calls[0][0].where as object;
    expect(where).not.toHaveProperty('user');
  });

  it('passes the accessible library ids through to the media counts', async () => {
    const { service, mediaService, libraries } = make({
      canManageRequests: false,
    });
    const counts = await service.getCounts(user);
    expect(libraries.getAccessibleLibraryIds).toHaveBeenCalledWith(user);
    expect(mediaService.getCountsByLibrary).toHaveBeenCalledWith([1, 2]);
    expect(counts.mediaByLibrary).toEqual({ 1: 10, 2: 20 });
  });

  it('returns empty media counts without the media read ability, without querying', async () => {
    const { service, mediaService, libraries } = make({
      canManageRequests: false,
      canReadMedia: false,
    });
    const counts = await service.getCounts(user);
    expect(counts.mediaByLibrary).toEqual({});
    expect(libraries.getAccessibleLibraryIds).not.toHaveBeenCalled();
    expect(mediaService.getCountsByLibrary).not.toHaveBeenCalled();
  });
});
