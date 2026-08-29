import { RequestLifecycleService } from './request-lifecycle.service';
import { RequestStatus, RequestKind } from '../../common/enums';
import { Media } from '../media/entities/media.entity';

describe('RequestLifecycleService onMediaRemoved (kind-aware)', () => {
  let requestRepo: { find: jest.Mock; save: jest.Mock };
  let service: RequestLifecycleService;

  beforeEach(() => {
    requestRepo = {
      find: jest.fn(),
      save: jest.fn(async (rows: unknown) => rows),
    };
    service = new RequestLifecycleService(
      requestRepo as never,
      {} as never,
      {} as never,
      { subscribe: jest.fn() } as never,
      {} as never,
      { viewersForMedia: jest.fn(async () => []) } as never,
    );
  });

  it('declines active add requests but resolves active delete requests to APPROVED', async () => {
    const addRequest = {
      id: 1,
      kind: RequestKind.ADD,
      status: RequestStatus.APPROVED,
      media: { id: 9 },
    };
    const deleteRequest = {
      id: 2,
      kind: RequestKind.DELETE,
      status: RequestStatus.PENDING,
      media: { id: 9 },
    };

    // The service queries add and delete requests separately by `kind`.
    requestRepo.find.mockImplementation(async (opts: any) =>
      opts.where.kind === RequestKind.DELETE ? [deleteRequest] : [addRequest],
    );

    await service.onMediaRemoved({ id: 9 } as Media);

    expect(deleteRequest.status).toBe(RequestStatus.APPROVED);
    expect(deleteRequest.media).toBeNull();
    expect(addRequest.status).toBe(RequestStatus.DECLINED);
    expect(addRequest.media).toBeNull();
  });

  it('resolves concurrent duplicate delete requests together', async () => {
    const first = {
      id: 2,
      kind: RequestKind.DELETE,
      status: RequestStatus.APPROVED,
      media: { id: 9 },
    };
    const duplicate = {
      id: 3,
      kind: RequestKind.DELETE,
      status: RequestStatus.PENDING,
      media: { id: 9 },
    };
    requestRepo.find.mockImplementation(async (opts: any) =>
      opts.where.kind === RequestKind.DELETE ? [first, duplicate] : [],
    );

    await service.onMediaRemoved({ id: 9 } as Media);

    expect(first.status).toBe(RequestStatus.APPROVED);
    expect(duplicate.status).toBe(RequestStatus.APPROVED);
    expect(duplicate.media).toBeNull();
  });
});

// The announcement is what makes an import satisfy a request: whoever owns acquisition acts on it
// instead of waiting for its own tick. Nothing asserted it, and a lost announcement is silent —
// the request flips to APPROVED and then sits there.
describe('RequestLifecycleService onMediaImported — acquisition announcement', () => {
  const media = { id: 91, tmdbId: 555, type: 'movie', qualityProfile: null, languageProfile: null };

  function makeService(opts: { covers: boolean; open: unknown[] }) {
    const requestRepo = {
      find: jest.fn(async () => opts.open),
      save: jest.fn(async (rows: unknown) => rows),
    };
    const events = { emitDomain: jest.fn(), subscribe: jest.fn() };
    const service = new RequestLifecycleService(
      requestRepo as never,
      { applyMonitoredForRequestScope: jest.fn() } as never,
      { envelopeCovers: jest.fn(async () => opts.covers) } as never,
      events as never,
      {} as never,
      { viewersForMedia: jest.fn(async () => []) } as never,
    );
    return { service, events, requestRepo };
  }

  const pending = () => ({
    id: 1,
    kind: RequestKind.ADD,
    status: RequestStatus.PENDING,
    seasons: null,
  });

  it('VERDICT: announces once the import adopted a request', async () => {
    const { service, events } = makeService({ covers: true, open: [pending()] });

    await service.onMediaImported(media as never, 3);

    expect(events.emitDomain).toHaveBeenCalledWith({
      type: 'media.acquisition.requested',
      mediaIds: [91],
      reason: 'media-imported',
    });
  });

  it('says nothing when the imported profiles cover no open request', async () => {
    const { service, events } = makeService({ covers: false, open: [pending()] });

    await service.onMediaImported(media as never, 3);

    expect(events.emitDomain).not.toHaveBeenCalled();
  });

  it('says nothing when there was no open request at all', async () => {
    const { service, events } = makeService({ covers: true, open: [] });

    await service.onMediaImported(media as never, 3);

    expect(events.emitDomain).not.toHaveBeenCalled();
  });
});

/**
 * The 0% push that makes the download badge show up on the button press rather
 * than on the acquisition plugin's next poll tick. It used to sit inside
 * `markInProgress`, behind its "no APPROVED request → return" guard, so a
 * direct grab — the common admin path — produced no feedback at all.
 */
describe('RequestLifecycleService announceGrab', () => {
  function makeService(open: unknown[]) {
    const events = { emitToUsers: jest.fn(), emitDomain: jest.fn(), subscribe: jest.fn() };
    const service = new RequestLifecycleService(
      { find: jest.fn(async () => open), save: jest.fn(async (r: unknown) => r) } as never,
      {} as never,
      {} as never,
      events as never,
      { dispatch: jest.fn() } as never,
      { viewersForMedia: jest.fn(async () => [7, 9]) } as never,
    );
    const announce = (mediaId: number, seasonNumber?: number) =>
      (
        service as unknown as {
          announceGrab: (m: number, s?: number) => Promise<void>;
        }
      ).announceGrab(mediaId, seasonNumber);
    return { announce, events };
  }

  it('pushes progress for a grab that matches no request at all', async () => {
    const { announce, events } = makeService([]);

    await announce(91, 2);

    expect(events.emitToUsers).toHaveBeenCalledWith(
      [7, 9],
      expect.objectContaining({
        type: 'download.progress',
        mediaId: 91,
        mediaType: 'series',
        seasonNumber: 2,
        progress: 0,
        state: 'active',
      }),
    );
  });

  it('types a grab with no season as a movie', async () => {
    const { announce, events } = makeService([]);

    await announce(91);

    expect(events.emitToUsers).toHaveBeenCalledWith(
      [7, 9],
      expect.objectContaining({ mediaType: 'movie', seasonNumber: undefined }),
    );
  });

  it('stays quiet when nobody can see the media', async () => {
    const events = { emitToUsers: jest.fn(), emitDomain: jest.fn(), subscribe: jest.fn() };
    const service = new RequestLifecycleService(
      { find: jest.fn(async () => []), save: jest.fn() } as never,
      {} as never,
      {} as never,
      events as never,
      {} as never,
      { viewersForMedia: jest.fn(async () => []) } as never,
    );

    await (
      service as unknown as { announceGrab: (m: number) => Promise<void> }
    ).announceGrab(91);

    expect(events.emitToUsers).not.toHaveBeenCalled();
  });
});
