describe('withFfmpegSlot', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  function loadWith(
    opts: {
      slots?: string;
      hostCores?: number;
      files?: Record<string, string>;
    } = {},
  ): typeof import('./ffmpeg-slots') {
    jest.resetModules();
    const env = { ...OLD_ENV };
    if (opts.slots != null) env.FLIKS_FFMPEG_SLOTS = opts.slots;
    else delete env.FLIKS_FFMPEG_SLOTS;
    process.env = env;

    jest.doMock('os', () => ({
      cpus: () => Array.from({ length: opts.hostCores ?? 4 }, () => ({})),
    }));
    jest.doMock('fs', () => ({
      readFileSync: (p: string) => {
        const content = opts.files?.[p];
        if (content == null) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return content;
      },
    }));

    return require('./ffmpeg-slots');
  }

  it('never runs more than the configured slot count concurrently', async () => {
    const { withFfmpegSlot } = loadWith({ slots: '2' });
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
    const { withFfmpegSlot } = loadWith({ slots: '1' });

    await expect(
      withFfmpegSlot(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The slot from the rejected call must be free, this would hang otherwise.
    const result = await withFfmpegSlot(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('ignores a non-positive-integer override', () => {
    expect(loadWith({ slots: '0' }).FFMPEG_SLOTS).toBeGreaterThan(0);
    expect(loadWith({ slots: '-3' }).FFMPEG_SLOTS).toBeGreaterThan(0);
    expect(loadWith({ slots: 'nope' }).FFMPEG_SLOTS).toBeGreaterThan(0);
  });

  it('honours a positive integer override', () => {
    expect(loadWith({ slots: '5' }).FFMPEG_SLOTS).toBe(5);
  });

  describe('cgroup CPU quota', () => {
    it('falls back to host cores minus one when no cgroup file is readable', () => {
      expect(loadWith({ hostCores: 8 }).FFMPEG_SLOTS).toBe(7);
    });

    it('caps at the cgroup v2 quota when tighter than the host', () => {
      const { FFMPEG_SLOTS } = loadWith({
        hostCores: 8,
        files: { '/sys/fs/cgroup/cpu.max': '200000 100000' }, // 2 cores
      });
      expect(FFMPEG_SLOTS).toBe(1); // min(8, 2) = 2, floor(2) - 1 = 1
    });

    it('treats cgroup v2 "max" as unlimited, falling back to host cores', () => {
      const { FFMPEG_SLOTS } = loadWith({
        hostCores: 4,
        files: { '/sys/fs/cgroup/cpu.max': 'max 100000' },
      });
      expect(FFMPEG_SLOTS).toBe(3);
    });

    it('caps at the cgroup v1 quota/period when v2 is absent', () => {
      const { FFMPEG_SLOTS } = loadWith({
        hostCores: 8,
        files: {
          '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '150000',
          '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        }, // 1.5 cores
      });
      expect(FFMPEG_SLOTS).toBe(1); // min(8, 1.5) = 1.5, floor = 1, - 1 = 0, floored at 1
    });

    it('treats cgroup v1 quota -1 as unlimited, falling back to host cores', () => {
      const { FFMPEG_SLOTS } = loadWith({
        hostCores: 4,
        files: {
          '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1',
          '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        },
      });
      expect(FFMPEG_SLOTS).toBe(3);
    });

    it('falls back to host cores on a malformed cgroup file instead of throwing', () => {
      const { FFMPEG_SLOTS } = loadWith({
        hostCores: 4,
        files: { '/sys/fs/cgroup/cpu.max': 'not-a-number garbage' },
      });
      expect(FFMPEG_SLOTS).toBe(3);
    });

    it('an explicit override still wins over a tighter cgroup quota', () => {
      const { FFMPEG_SLOTS } = loadWith({
        slots: '6',
        hostCores: 8,
        files: { '/sys/fs/cgroup/cpu.max': '100000 100000' }, // 1 core
      });
      expect(FFMPEG_SLOTS).toBe(6);
    });
  });
});
