import { execFile } from 'child_process';
import { existsSync } from 'fs';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

import { FfprobeService } from './ffprobe.service';

type Cb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

const execFileMock = execFile as unknown as jest.Mock;
const existsSyncMock = existsSync as unknown as jest.Mock;

/** Every ffmpeg invocation the service made, as one argv array each. */
const calls = (): string[][] =>
  execFileMock.mock.calls.map((c) => c[1] as string[]);

function reply(stderr: string) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb: Cb) =>
    cb(null, { stdout: '', stderr }),
  );
}

describe('cropdetect', () => {
  const svc = new FfprobeService();
  const detect = (w = 1920, h = 1080) =>
    svc.detectCrop('/m/ep.mkv', 3600, w, h);

  beforeEach(() => {
    execFileMock.mockReset();
    existsSyncMock.mockReset();
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
    existsSyncMock.mockReturnValue(true);
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
});
