import { execFile } from 'child_process';
import { existsSync } from 'fs';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

import { FfprobeService } from './ffprobe.service';

type Cb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

const execFileMock = execFile as unknown as jest.Mock;
const existsSyncMock = existsSync as unknown as jest.Mock;

/** Every ffmpeg invocation the service made, as one argv array each, with the
 *  linux `ionice -c3 nice -n19` wrapper stripped (asserted separately below). */
const calls = (): string[][] =>
  execFileMock.mock.calls.map((c) => {
    const argv = c[1] as string[];
    const ffmpeg = argv.indexOf('ffmpeg');
    return ffmpeg === -1 ? argv : argv.slice(ffmpeg + 1);
  });

function reply(stderr: string) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb: Cb) =>
    cb(null, { stdout: '', stderr }),
  );
}

describe('cropdetect', () => {
  const svc = new FfprobeService();
  const detect = (w = 1920, h = 1080) =>
    svc.detectCrop('/m/ep.mkv', 3600, w, h);

  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;
  function setPlatform(value: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it('normalises to 8-bit before cropdetect, with one limit for every source', () => {
    // A 10-bit source encodes black near 64, so the 8-bit default limit of 24
    // finds nothing black; without format=nv12 the bars are silently missed.
    existsSyncMock.mockReturnValue(false);
    reply('crop=1920:800:0:140');
    return detect().then((crop) => {
      expect(crop).toEqual({ width: 1920, height: 800, x: 0, y: 140 });
      for (const argv of calls()) {
        const vf = argv[argv.indexOf('-vf') + 1];
        expect(vf).toContain('format=nv12,cropdetect=');
        expect(vf).toContain('limit=24');
      }
    });
  });

  it('decodes on the GPU when a render node is there, and keeps 6 samples', async () => {
    setPlatform('linux');
    existsSyncMock.mockImplementation((p: string) => p === '/dev/dri/renderD128');
    reply('crop=1920:800:0:140');
    await detect();

    expect(calls()).toHaveLength(6);
    for (const argv of calls()) {
      expect(argv.slice(0, 6)).toEqual([
        '-hwaccel',
        'vaapi',
        '-hwaccel_device',
        '/dev/dri/renderD128',
        '-hwaccel_output_format',
        'vaapi',
      ]);
      expect(argv[argv.indexOf('-vf') + 1]).toContain('hwdownload,format=nv12');
      expect(argv).not.toContain('-threads');
    }
  });

  it('runs the probe at idle I/O and CPU priority on linux', async () => {
    if (process.platform !== 'linux') return;
    existsSyncMock.mockReturnValue(false);
    reply('crop=1920:800:0:140');
    await detect();

    for (const [cmd, argv] of execFileMock.mock.calls as [string, string[]][]) {
      expect(cmd).toBe('ionice');
      expect(argv.slice(0, 4)).toEqual(['-c3', 'nice', '-n19', 'ffmpeg']);
    }
  });

  it('falls back to software for the whole file when the GPU refuses it', async () => {
    // HW decode support is per-codec, so the first sample is the probe.
    existsSyncMock.mockReturnValue(true);
    let n = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: Cb) =>
      ++n === 1
        ? cb(new Error('Failed to initialise VAAPI decoder'), {
            stdout: '',
            stderr: '',
          })
        : cb(null, { stdout: '', stderr: 'crop=1920:800:0:140' }),
    );

    const crop = await detect();
    expect(crop).toEqual({ width: 1920, height: 800, x: 0, y: 140 });
    // probe + the retried first sample + the 5 remaining ones
    expect(calls()).toHaveLength(7);
    for (const argv of calls().slice(1)) {
      expect(argv).not.toContain('-hwaccel');
      expect(argv).toContain('-threads');
    }
  });

  it('keeps the loosest box across samples and ignores insignificant bars', async () => {
    existsSyncMock.mockReturnValue(false);
    let n = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: Cb) =>
      cb(null, {
        stdout: '',
        // One dark scene reports a far tighter box than the real letterbox.
        stderr: ++n === 3 ? 'crop=1904:944:8:130' : 'crop=1920:1072:0:4',
      }),
    );
    // 1080 - 1072 = 8px total: below the 40px significance floor.
    expect(await detect()).toBeNull();
  });

  const CROP_FILTER = 'format=nv12,cropdetect=limit=24:round=16:reset=0:skip=24';

  it('decodes on cuda when only /dev/nvidiactl exists (no render node)', async () => {
    setPlatform('linux');
    existsSyncMock.mockImplementation((p: string) => p === '/dev/nvidiactl');
    reply('crop=1920:800:0:140');
    await detect();

    for (const argv of calls()) {
      expect(argv.slice(0, 2)).toEqual(['-hwaccel', 'cuda']);
      expect(argv.indexOf('-hwaccel')).toBeLessThan(argv.indexOf('-i'));
      expect(argv[argv.indexOf('-vf') + 1]).toBe(CROP_FILTER);
      expect(argv).not.toContain('-threads');
    }
  });

  it('decodes on d3d11va on win32, ignoring existsSync', async () => {
    setPlatform('win32');
    existsSyncMock.mockReturnValue(false);
    reply('crop=1920:800:0:140');
    await detect();

    for (const argv of calls()) {
      expect(argv.slice(0, 2)).toEqual(['-hwaccel', 'd3d11va']);
      expect(argv).not.toContain('-hwaccel_output_format');
      expect(argv[argv.indexOf('-vf') + 1]).toBe(CROP_FILTER);
    }
  });

  it('decodes on videotoolbox on darwin', async () => {
    setPlatform('darwin');
    existsSyncMock.mockReturnValue(false);
    reply('crop=1920:800:0:140');
    await detect();

    for (const argv of calls()) {
      expect(argv.slice(0, 2)).toEqual(['-hwaccel', 'videotoolbox']);
      expect(argv).not.toContain('-hwaccel_output_format');
      expect(argv[argv.indexOf('-vf') + 1]).toBe(CROP_FILTER);
    }
  });

  it('falls back to software the same way on win32 (platform-agnostic fallback)', async () => {
    setPlatform('win32');
    existsSyncMock.mockReturnValue(false);
    let n = 0;
    execFileMock.mockImplementation((_cmd, _args, _opts, cb: Cb) =>
      ++n === 1
        ? cb(new Error('d3d11va init failed'), { stdout: '', stderr: '' })
        : cb(null, { stdout: '', stderr: 'crop=1920:800:0:140' }),
    );

    await detect();
    // probe + the retried first sample + the 5 remaining ones
    expect(calls()).toHaveLength(7);
    for (const argv of calls().slice(1)) {
      expect(argv).not.toContain('-hwaccel');
      expect(argv).toContain('-threads');
    }
  });
});
