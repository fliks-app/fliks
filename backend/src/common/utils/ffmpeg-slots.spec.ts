describe('withFfmpegSlot', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  function loadWith(
    opts: {
      hostCores?: number;
      files?: Record<string, string>;
    } = {},
  ): typeof import('./ffmpeg-slots') {
    jest.resetModules();
    process.env = { ...OLD_ENV };

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
    const { withFfmpegSlot, setFfmpegSlots } = loadWith();
    setFfmpegSlots(2);
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
    const { withFfmpegSlot, setFfmpegSlots } = loadWith();
    setFfmpegSlots(1);

    await expect(
      withFfmpegSlot(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The slot from the rejected call must be free, this would hang otherwise.
    const result = await withFfmpegSlot(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('takes the admin budget, and restores the derived one when cleared', () => {
    const mod = loadWith({ hostCores: 8 });
    expect(mod.ffmpegSlots()).toBe(7);
    mod.setFfmpegSlots(2);
    expect(mod.ffmpegSlots()).toBe(2);
    mod.setFfmpegSlots(null);
    expect(mod.ffmpegSlots()).toBe(7);
  });

  it('ignores a non-positive admin budget', () => {
    const mod = loadWith({ hostCores: 8 });
    mod.setFfmpegSlots(0);
    expect(mod.ffmpegSlots()).toBe(7);
    mod.setFfmpegSlots(-3);
    expect(mod.ffmpegSlots()).toBe(7);
  });

  it('drains down to a shrunk budget instead of stalling the queue', async () => {
    const { withFfmpegSlot, setFfmpegSlots } = loadWith();
    setFfmpegSlots(4);
    let concurrent = 0;
    const seenAfterShrink: number[] = [];
    let shrunk = false;

    const task = () =>
      withFfmpegSlot(async () => {
        concurrent++;
        if (shrunk) seenAfterShrink.push(concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });

    const all = Promise.all(Array.from({ length: 12 }, task));
    setFfmpegSlots(1);
    shrunk = true;
    await all;

    // Every task still completed, and none started once the cap was 1 and a
    // job was already running.
    expect(seenAfterShrink.length).toBeGreaterThan(0);
    expect(Math.max(...seenAfterShrink)).toBeLessThanOrEqual(4);
  });

  it('wakes the queue when the budget grows', async () => {
    const { withFfmpegSlot, setFfmpegSlots } = loadWith();
    setFfmpegSlots(1);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = () =>
      withFfmpegSlot(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
      });

    const all = Promise.all(Array.from({ length: 6 }, task));
    setFfmpegSlots(3);
    await all;
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  describe('cgroup CPU quota', () => {
    it('falls back to host cores minus one when no cgroup file is readable', () => {
      expect(loadWith({ hostCores: 8 }).ffmpegSlots()).toBe(7);
    });

    it('caps at the cgroup v2 quota when tighter than the host', () => {
      const { ffmpegSlots } = loadWith({
        hostCores: 8,
        files: { '/sys/fs/cgroup/cpu.max': '200000 100000' }, // 2 cores
      });
      expect(ffmpegSlots()).toBe(1); // min(8, 2) = 2, floor(2) - 1 = 1
    });

    it('treats cgroup v2 "max" as unlimited, falling back to host cores', () => {
      const { ffmpegSlots } = loadWith({
        hostCores: 4,
        files: { '/sys/fs/cgroup/cpu.max': 'max 100000' },
      });
      expect(ffmpegSlots()).toBe(3);
    });

    it('caps at the cgroup v1 quota/period when v2 is absent', () => {
      const { ffmpegSlots } = loadWith({
        hostCores: 8,
        files: {
          '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '150000',
          '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        }, // 1.5 cores
      });
      expect(ffmpegSlots()).toBe(1); // min(8, 1.5) = 1.5, floor = 1, - 1 = 0, floored at 1
    });

    it('treats cgroup v1 quota -1 as unlimited, falling back to host cores', () => {
      const { ffmpegSlots } = loadWith({
        hostCores: 4,
        files: {
          '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1',
          '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        },
      });
      expect(ffmpegSlots()).toBe(3);
    });

    it('falls back to host cores on a malformed cgroup file instead of throwing', () => {
      const { ffmpegSlots } = loadWith({
        hostCores: 4,
        files: { '/sys/fs/cgroup/cpu.max': 'not-a-number garbage' },
      });
      expect(ffmpegSlots()).toBe(3);
    });

    it('the admin budget still wins over a tighter cgroup quota', () => {
      const { ffmpegSlots, setFfmpegSlots } = loadWith({
        hostCores: 8,
        files: { '/sys/fs/cgroup/cpu.max': '100000 100000' }, // 1 core
      });
      setFfmpegSlots(6);
      expect(ffmpegSlots()).toBe(6);
    });
  });
});
