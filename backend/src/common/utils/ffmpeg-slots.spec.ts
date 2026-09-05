describe('withFfmpegSlot', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  function loadWith(slots: string): typeof import('./ffmpeg-slots') {
    jest.resetModules();
    process.env = { ...OLD_ENV, FLIKS_FFMPEG_SLOTS: slots };
    return require('./ffmpeg-slots');
  }

  it('never runs more than the configured slot count concurrently', async () => {
    const { withFfmpegSlot } = loadWith('2');
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      withFfmpegSlot(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });

    await Promise.all(Array.from({ length: 10 }, task));
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('releases the slot when fn rejects', async () => {
    const { withFfmpegSlot } = loadWith('1');

    await expect(
      withFfmpegSlot(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The slot from the rejected call must be free — this would hang otherwise.
    const result = await withFfmpegSlot(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('ignores a non-positive-integer override', () => {
    expect(loadWith('0').FFMPEG_SLOTS).toBeGreaterThan(0);
    expect(loadWith('-3').FFMPEG_SLOTS).toBeGreaterThan(0);
    expect(loadWith('nope').FFMPEG_SLOTS).toBeGreaterThan(0);
  });

  it('honours a positive integer override', () => {
    expect(loadWith('5').FFMPEG_SLOTS).toBe(5);
  });
});
