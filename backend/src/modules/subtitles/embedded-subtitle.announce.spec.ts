import { EmbeddedSubtitleService } from './embedded-subtitle.service';

/** The client caches a media's subtitle list and only drops it on an event. An import runs this
 *  service on its own, so the announcement is the only thing standing between a stored image
 *  track and a list that stays stale until its TTL lapses. */
describe('EmbeddedSubtitleService — announcing what an import stored', () => {
  const build = (streams: unknown[]) => {
    const emit = jest.fn();
    const saved = streams.map((_, i) => ({ id: i + 1 }));
    const service = new EmbeddedSubtitleService(
      { detectEmbeddedSubtitles: jest.fn().mockResolvedValue(streams) } as never,
      {
        find: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue(undefined),
        save: jest.fn().mockResolvedValue(saved),
      } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 7, path: '/library/a' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 42, relativePath: 'a.mkv' }) } as never,
      { get: jest.fn().mockResolvedValue('false') } as never,
      { emit } as never,
    );
    return { service, emit };
  };

  const imageStream = {
    streamIndex: 5,
    language: 'fr',
    forced: false,
    hearingImpaired: false,
    codec: 'hdmv_pgs_subtitle',
    isImageBased: true,
  };

  it('announces the media whose list just changed', async () => {
    const { service, emit } = build([imageStream]);
    await service.detectAndStore(7, 42);
    expect(emit).toHaveBeenCalledWith({ type: 'subtitle.list_changed', mediaId: 7 });
  });

  it('stays quiet when the probe found nothing to store', async () => {
    const { service, emit } = build([]);
    await service.detectAndStore(7, 42);
    expect(emit).not.toHaveBeenCalled();
  });
});
