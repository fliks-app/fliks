import { ThumbnailService } from './thumbnail.service';

describe('ThumbnailService.generateForFile', () => {
  const sprite = {
    interval: 5,
    columns: 10,
    thumbWidth: 240,
    thumbHeight: 135,
    count: 20,
  };
  const file = {
    id: 4,
    relativePath: 'a.mkv',
    streamInfo: { durationSeconds: 100, video: [], audio: [], subtitles: [] },
  };
  const media = { path: '/m', title: 'T' };
  const subject = { id: 1, title: 'T' } as never;

  function make(runJob: jest.Mock) {
    const activity = {
      upsertPending: jest.fn(),
      upsertRunning: jest.fn(),
      remove: jest.fn(),
    };
    return {
      activity,
      svc: new ThumbnailService({ runJob } as never, activity as never),
    };
  }

  it('asks the engine for a Sprite job and returns its metadata', async () => {
    const runJob = jest.fn(
      async (_req: unknown, onProgress?: (p: number) => void) => {
        onProgress?.(40);
        return { type: 'Sprite', sprite };
      },
    );
    const { svc, activity } = make(runJob);
    expect(
      await svc.generateForFile(file, media, subject, {
        force: true,
        priority: 'high',
      }),
    ).toBe(sprite);
    expect(runJob.mock.calls[0][0]).toEqual({
      kind: { type: 'Sprite', info: file.streamInfo },
      media: { mediaFileId: 4, path: '/m/a.mkv' },
      priority: 'high',
      force: true,
    });
    expect(activity.upsertRunning).toHaveBeenCalledWith(
      'GenerateSprite:4',
      'GenerateSprite',
      subject,
      40,
      100,
    );
    expect(activity.remove).toHaveBeenCalledWith('GenerateSprite:4');
  });

  it('is null without a duration, or when the job fails', async () => {
    const runJob = jest.fn().mockRejectedValue(new Error('engine job failed'));
    const { svc } = make(runJob);
    expect(
      await svc.generateForFile({ ...file, streamInfo: null }, media, subject),
    ).toBeNull();
    expect(runJob).not.toHaveBeenCalled();
    expect(await svc.generateForFile(file, media, subject)).toBeNull();
  });
});
