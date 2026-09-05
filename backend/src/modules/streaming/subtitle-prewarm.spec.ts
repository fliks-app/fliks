import { SubtitleStreamService } from './subtitle-stream.service';
import type { SubtitlePrewarm } from './streaming-settings-cache.service';

/** The service with only what warmupCache touches before it decides to queue. */
function makeService(mode: SubtitlePrewarm) {
  const commandRepo = { create: jest.fn((v) => v), save: jest.fn(async (v) => v) };
  const svc = new SubtitleStreamService(
    null as never,
    commandRepo as never,
    null as never,
    { emit: jest.fn() } as never,
    { get: async () => ({ subtitlePrewarm: mode }) } as never,
    { upsertPending: jest.fn(), upsertRunning: jest.fn(), remove: jest.fn() } as never,
  );
  const queued = jest
    .spyOn(svc as unknown as { processWarmupQueue(): void }, 'processWarmupQueue')
    .mockImplementation(() => {});
  return { svc, queued };
}

const SUBS = [
  { streamIndex: 2, isImageBased: false },
  { streamIndex: 3, isImageBased: true },
];

const warm = (svc: SubtitleStreamService, trigger: 'import' | 'playback') =>
  svc.warmupCache('/m/s01e01.mkv', 1, SUBS, { title: 'Ep' }, trigger);

describe('subtitle prewarm', () => {
  it.each([
    ['off', 'import', false],
    ['off', 'playback', false],
    ['playback', 'import', false],
    ['playback', 'playback', true],
    ['import', 'import', true],
    ['import', 'playback', true],
  ] as const)('%s + %s trigger → queued=%s', async (mode, trigger, expected) => {
    const { svc, queued } = makeService(mode);
    await warm(svc, trigger);
    expect(queued).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it('defaults to the import trigger, so a caller that forgets stays gated', async () => {
    const { svc, queued } = makeService('playback');
    await svc.warmupCache('/m/s01e01.mkv', 1, SUBS, { title: 'Ep' });
    expect(queued).not.toHaveBeenCalled();
  });

  it('never queues image-based tracks: they burn in, they have no VTT form', async () => {
    const { svc, queued } = makeService('import');
    await svc.warmupCache('/m/s01e01.mkv', 1, [SUBS[1]], { title: 'Ep' }, 'import');
    expect(queued).not.toHaveBeenCalled();
  });
});
