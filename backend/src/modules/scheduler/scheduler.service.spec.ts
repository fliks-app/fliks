import { BadRequestException } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PluginJobsService } from '../plugins/plugin-jobs.service';
import { ScheduledJobRegistry } from './scheduled-job-registry.service';
import { MediaType, MediaStatus } from '../../common/enums';

function fakePluginJobs(overrides: Partial<Record<'listDeclared' | 'trigger', jest.Mock>> = {}) {
  return {
    listDeclared: jest.fn().mockReturnValue([]),
    trigger: jest.fn(),
    ...overrides,
  };
}

/** Only `commandRepo`+`pluginJobs`+`jobRegistry` are ever touched by `triggerCommand`'s
 *  unknown-name and plugin-job branches — every other dependency stays an unused stub. */
function makeService(pluginJobs: ReturnType<typeof fakePluginJobs>, jobRegistry: { list: jest.Mock } = { list: jest.fn().mockReturnValue([]) }) {
  const unused = {} as never;
  return new SchedulerService(
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    pluginJobs as unknown as PluginJobsService,
    jobRegistry as unknown as ScheduledJobRegistry,
    unused,
    unused,
    unused,
    unused,
  );
}

describe('SchedulerService.triggerCommand', () => {
  it('routes a declared plugin job name through PluginJobsService.trigger()', async () => {
    const pluginJobs = fakePluginJobs({
      listDeclared: jest.fn().mockReturnValue([
        { pluginId: 'fliks.p', job: { name: 'sync', cron: '0 0 * * *', triggerable: true, labelKey: 'k' } },
      ]),
      trigger: jest.fn().mockReturnValue({ ok: true }),
    });
    const service = makeService(pluginJobs);

    const result = await service.triggerCommand('sync');

    expect(pluginJobs.trigger).toHaveBeenCalledWith('fliks.p', 'sync');
    expect(result).toEqual({ ok: true });
  });

  it('400s a declared-but-not-triggerable plugin job instead of dispatching it', async () => {
    const pluginJobs = fakePluginJobs({
      listDeclared: jest.fn().mockReturnValue([
        { pluginId: 'fliks.p', job: { name: 'sync', cron: '0 0 * * *', triggerable: false, labelKey: 'k' } },
      ]),
      trigger: jest.fn().mockReturnValue({ ok: false, reason: 'not-triggerable' }),
    });
    const service = makeService(pluginJobs);

    await expect(service.triggerCommand('sync')).rejects.toThrow(/not triggerable/);
    expect(pluginJobs.trigger).toHaveBeenCalledWith('fliks.p', 'sync');
  });

  it('still 400s a name that is neither a core command nor a declared plugin job', async () => {
    const pluginJobs = fakePluginJobs();
    const service = makeService(pluginJobs);

    await expect(service.triggerCommand('NoSuchJob')).rejects.toThrow(BadRequestException);
    expect(pluginJobs.trigger).not.toHaveBeenCalled();
  });
});

function makeMetadataService(
  mediaRepo: { find: jest.Mock },
  mediaService: { refreshMetadata: jest.Mock },
  config: { get: jest.Mock },
) {
  const unused = {} as never;
  const eventsService = { emit: jest.fn() };
  const activityRegistry = {
    upsertRunning: jest.fn(),
    upsertPending: jest.fn(),
    remove: jest.fn(),
  };
  return new SchedulerService(
    unused,
    mediaRepo as never,
    unused,
    unused,
    mediaService as never,
    config as never,
    eventsService as never,
    unused,
    unused,
    unused,
    unused,
    fakePluginJobs() as unknown as PluginJobsService,
    { list: jest.fn().mockReturnValue([]) } as unknown as ScheduledJobRegistry,
    unused,
    unused,
    unused,
    activityRegistry as never,
  );
}

function unidentifiedMedia(id: number) {
  return {
    id,
    title: 'Sample Movie',
    type: MediaType.MOVIE,
    status: MediaStatus.RELEASED,
    tmdbId: null,
    tvdbId: null,
    imdbId: null,
    metadataRefreshedAt: null,
    year: 2020,
    releaseDate: null,
    posterUrl: null,
    overview: null,
  };
}

function identifiedMedia(id: number) {
  return {
    ...unidentifiedMedia(id),
    title: 'Sample Movie 2',
    tmdbId: 42,
  };
}

describe('SchedulerService metadata refresh jobs skip unidentified titles', () => {
  it('doRefreshMetadata never refreshes or fails a media with no provider id', async () => {
    const mediaRepo = {
      find: jest.fn().mockResolvedValue([identifiedMedia(1), unidentifiedMedia(2)]),
    };
    const mediaService = { refreshMetadata: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue('a-key') };
    const service = makeMetadataService(mediaRepo, mediaService, config);

    await (service as unknown as { doRefreshMetadata: () => Promise<void> }).doRefreshMetadata();

    expect(mediaService.refreshMetadata).toHaveBeenCalledTimes(1);
    expect(mediaService.refreshMetadata).toHaveBeenCalledWith(1);
  });

  it('doRefreshMissingMetadata never refreshes or fails a media with no provider id', async () => {
    const mediaRepo = {
      find: jest.fn().mockResolvedValue([identifiedMedia(1), unidentifiedMedia(2)]),
    };
    const mediaService = { refreshMetadata: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue('a-key') };
    const service = makeMetadataService(mediaRepo, mediaService, config);

    await (
      service as unknown as { doRefreshMissingMetadata: () => Promise<void> }
    ).doRefreshMissingMetadata();

    expect(mediaService.refreshMetadata).toHaveBeenCalledTimes(1);
    expect(mediaService.refreshMetadata).toHaveBeenCalledWith(1);
  });
});
