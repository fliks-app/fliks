import { PostImportQueueService } from './post-import-queue.service';

function makeFile(mediaFileId: number) {
  return {
    id: mediaFileId,
    relativePath: `file-${mediaFileId}.mkv`,
    episodeId: null,
    media: { id: 1, path: '/media', title: 'Title' },
  };
}

function makeQueue() {
  const findOne = jest.fn((opts: { where: { id: number } }) =>
    Promise.resolve(makeFile(opts.where.id)),
  );
  const finalize = jest.fn(async () => undefined);
  const onImported = jest.fn(async () => undefined);
  const events = { emit: jest.fn() };

  const queue = new PostImportQueueService(
    { findOne } as never,
    { finalizeImportedFile: finalize } as never,
    { onMediaFileImported: onImported } as never,
    events as never,
  );
  return { queue, findOne, finalize, onImported, events };
}

describe('PostImportQueueService', () => {
  it('dedups a second enqueue of the same mediaFileId while it is queued/running', () => {
    const { queue, findOne } = makeQueue();
    findOne.mockReturnValue(new Promise(() => {}) as never); // never resolves: still "running"

    queue.enqueue({ mediaFileId: 1 });
    queue.enqueue({ mediaFileId: 1 });

    expect(queue.pendingCount).toBe(1);
  });

  it('whenIdle resolves after a task rejects, with no unhandled rejection', async () => {
    const { queue, findOne } = makeQueue();
    findOne.mockRejectedValueOnce(new Error('db down'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    queue.enqueue({ mediaFileId: 2 });
    await queue.whenIdle();
    await new Promise((r) => setImmediate(r));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('accepts enqueue called from inside a running task', async () => {
    const { queue, finalize } = makeQueue();
    finalize.mockImplementationOnce(async () => {
      queue.enqueue({ mediaFileId: 99 });
    });

    queue.enqueue({ mediaFileId: 1 });
    await queue.whenIdle();

    expect(finalize).toHaveBeenCalledTimes(2);
  });
});
