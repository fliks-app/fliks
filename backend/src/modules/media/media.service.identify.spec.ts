import { MediaService } from './media.service';

/**
 * Dropping the old work's episodes leaves their files with no episode
 * (`ON DELETE SET NULL`), so until they are relinked the new work's episodes
 * read as missing while the files sit on disk. Letting the auto-grab pipeline
 * see that state re-downloads what is already there.
 */
describe('MediaService.finishIdentify', () => {
  function harness(opts: { rescanFails?: boolean } = {}) {
    const calls: string[] = [];
    const service = Object.create(MediaService.prototype) as MediaService;
    Object.assign(service, {
      metadata: {
        completeIdentify: async () => {
          calls.push('refresh');
          return { id: 1, title: 'New Work' };
        },
      },
      rescan: {
        rescanFiles: async () => {
          calls.push('rescan');
          if (opts.rescanFails) throw new Error('no root path configured');
          return {};
        },
      },
      events: { emitDomain: () => calls.push('acquisition') },
      logger: { warn: () => undefined },
    });
    return { service, calls };
  }

  it('VERDICT: relinks the files before letting the grab pipeline look at them', async () => {
    const { service, calls } = harness();

    await service.finishIdentify(1);

    expect(calls).toEqual(['refresh', 'rescan', 'acquisition']);
  });

  it('returns the refreshed media', async () => {
    const { service } = harness();

    await expect(service.finishIdentify(1)).resolves.toMatchObject({
      title: 'New Work',
    });
  });

  it('finishes the identification even when nothing can be relinked', async () => {
    const { service, calls } = harness({ rescanFails: true });

    await service.finishIdentify(1);

    expect(calls).toEqual(['refresh', 'rescan', 'acquisition']);
  });
});
