import { LiveTvLogoService } from './livetv-logo.service';

function makeImages(overrides: { downloadAndStore?: jest.Mock } = {}) {
  return {
    downloadAndStore: jest.fn().mockResolvedValue('/api/images/livetv/1?v=abc'),
    ...overrides,
  } as unknown as import('../../images/image.service').ImageService;
}

function makeChannelRepo() {
  return { update: jest.fn().mockResolvedValue(undefined) } as unknown as import('typeorm').Repository<
    import('../entities/livetv-channel.entity').LiveTvChannel
  >;
}

describe('LiveTvLogoService', () => {
  it('skips channels with no logo or a non-http logo (already cached locally)', async () => {
    const images = makeImages();
    const channelRepo = makeChannelRepo();
    const service = new LiveTvLogoService(channelRepo, images);

    await service.cacheLogos([
      { id: 1, logoPath: null },
      { id: 2, logoPath: '/api/images/livetv/2' },
    ]);

    expect(images.downloadAndStore).not.toHaveBeenCalled();
    expect(channelRepo.update).not.toHaveBeenCalled();
  });

  it('stores the returned local path on success', async () => {
    const images = makeImages();
    const channelRepo = makeChannelRepo();
    const service = new LiveTvLogoService(channelRepo, images);

    await service.cacheLogos([{ id: 5, logoPath: 'http://provider/logo.png' }]);

    expect(images.downloadAndStore).toHaveBeenCalledWith(
      'http://provider/logo.png',
      expect.anything(),
      5,
      'logo',
    );
    expect(channelRepo.update).toHaveBeenCalledWith(5, {
      logoPath: '/api/images/livetv/1?v=abc',
    });
  });

  it('leaves the remote url in place when the download fails', async () => {
    const images = makeImages({ downloadAndStore: jest.fn().mockRejectedValue(new Error('boom')) });
    const channelRepo = makeChannelRepo();
    const service = new LiveTvLogoService(channelRepo, images);

    await expect(
      service.cacheLogos([{ id: 7, logoPath: 'http://provider/logo.png' }]),
    ).resolves.toBeUndefined();
    expect(channelRepo.update).not.toHaveBeenCalled();
  });

  it('leaves the remote url in place when downloadAndStore resolves null', async () => {
    const images = makeImages({ downloadAndStore: jest.fn().mockResolvedValue(null) });
    const channelRepo = makeChannelRepo();
    const service = new LiveTvLogoService(channelRepo, images);

    await service.cacheLogos([{ id: 8, logoPath: 'http://provider/logo.png' }]);
    expect(channelRepo.update).not.toHaveBeenCalled();
  });

  it('never runs more than the concurrency cap at once', async () => {
    let active = 0;
    let maxActive = 0;
    const images = makeImages({
      downloadAndStore: jest.fn().mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return '/api/images/livetv/x';
      }),
    });
    const channelRepo = makeChannelRepo();
    const service = new LiveTvLogoService(channelRepo, images);

    const channels = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      logoPath: `http://provider/${i}.png`,
    }));
    await service.cacheLogos(channels);

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(images.downloadAndStore).toHaveBeenCalledTimes(10);
  });
});
