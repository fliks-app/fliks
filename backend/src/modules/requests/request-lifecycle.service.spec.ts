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
      {} as never,
      {} as never,
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
