import { EmbeddedSubtitleService } from './embedded-subtitle.service';

/** The client caches a media's subtitle list and only drops it on an event. An import runs this
 *  service on its own, so the announcement is the only thing standing between a stored image
 *  track and a list that stays stale until its TTL lapses. */
describe('EmbeddedSubtitleService — announcing what an import stored', () => {
  const build = (
    probe: { ok: boolean; streams: unknown[] },
    opts: { alreadyStored?: number } = {},
  ) => {
    const emit = jest.fn();
    const del = jest.fn().mockResolvedValue({ affected: opts.alreadyStored ?? 0 });
    const saved = probe.streams.map((_, i) => ({ id: i + 1 }));
    const service = new EmbeddedSubtitleService(
      { detectEmbeddedSubtitles: jest.fn().mockResolvedValue(probe) } as never,
      {
        find: jest.fn().mockResolvedValue([]),
        delete: del,
        save: jest.fn().mockResolvedValue(saved),
      } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 7, path: '/library/a' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ id: 42, relativePath: 'a.mkv' }) } as never,
      { get: jest.fn().mockResolvedValue('false') } as never,
      { emit } as never,
    );
    return { service, emit, del };
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
    const { service, emit } = build({ ok: true, streams: [imageStream] });
    await service.detectAndStore(7, 42);
    expect(emit).toHaveBeenCalledWith({ type: 'subtitle.list_changed', mediaId: 7 });
  });

  it('retires the rows of a file whose tracks are gone, and says so', async () => {
    // A remux that drops every subtitle track: callers rely on the wipe to retire them.
    const { service, emit, del } = build({ ok: true, streams: [] }, { alreadyStored: 3 });
    await service.detectAndStore(7, 42);
    expect(del).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: 'subtitle.list_changed', mediaId: 7 });
  });

  it('keeps the stored rows when the probe itself failed', async () => {
    // ffprobe answers the same empty list on a timeout as on a file with no track. Deleting
    // here would lose a whole file's subtitles to one unreadable mount.
    const { service, emit, del } = build({ ok: false, streams: [] }, { alreadyStored: 3 });
    await service.detectAndStore(7, 42);
    expect(del).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('stays quiet when a rescan changed nothing', async () => {
    // Every rescan sweeps every file; a no-op must not wake every client.
    const { service, emit } = build({ ok: true, streams: [] }, { alreadyStored: 0 });
    await service.detectAndStore(7, 42);
    expect(emit).not.toHaveBeenCalled();
  });
});
