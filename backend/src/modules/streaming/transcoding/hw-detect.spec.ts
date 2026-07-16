jest.mock('child_process', () => ({ execFile: jest.fn() }));

import { execFile } from 'child_process';
import { Logger } from '@nestjs/common';
import { detectHwAccel, requestedHwAccelFor } from './hw-detect';

const mockExecFile = execFile as unknown as jest.Mock;
const log = { log: () => {} } as unknown as Logger;

/** Drive the promisified execFile: succeed only for arg slices that pass
 *  `accept`, so tests can pick which HW probe "works". */
function programProbes(accept: (args: string[]) => boolean): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    if (accept(args as string[])) cb(null, { stdout: '', stderr: '' });
    else cb(new Error('probe failed'));
  });
}

/** The `-c:v <encoder>` each probe invocation asked for, in call order. */
function probedEncoders(): string[] {
  return mockExecFile.mock.calls.map((call) => {
    const args = call[1] as string[];
    return args[args.indexOf('-c:v') + 1];
  });
}

describe('detectHwAccel', () => {
  beforeEach(() => mockExecFile.mockReset());

  it('picks native QSV first on Windows', async () => {
    programProbes((args) => args.includes('qsv=qs') && args.includes('h264_qsv'));
    expect(await detectHwAccel(log, 'win32')).toBe('qsv');
  });

  it('picks AMF second on Windows when QSV fails', async () => {
    programProbes(
      (args) => args.includes('d3d11va') && args.includes('h264_amf'),
    );
    expect(await detectHwAccel(log, 'win32')).toBe('amf');
  });

  it('falls back to NVENC on Windows when QSV and AMF fail', async () => {
    programProbes((args) => args.includes('h264_nvenc'));
    expect(await detectHwAccel(log, 'win32')).toBe('nvenc');
  });

  it('probes QSV -> AMF -> NVENC on Windows, never VAAPI', async () => {
    programProbes(() => false);
    await detectHwAccel(log, 'win32');
    expect(probedEncoders()).toEqual(['h264_qsv', 'h264_amf', 'h264_nvenc']);
  });

  it('returns none on Windows when every probe fails', async () => {
    programProbes(() => false);
    expect(await detectHwAccel(log, 'win32')).toBe('none');
  });

  it('keeps the Linux probe order QSV -> VAAPI -> NVENC', async () => {
    programProbes(() => false);
    await detectHwAccel(log, 'linux');
    expect(probedEncoders()).toEqual(['h264_qsv', 'h264_vaapi', 'h264_nvenc']);
  });

  it('probes only VideoToolbox on macOS', async () => {
    programProbes(() => false);
    await detectHwAccel(log, 'darwin');
    expect(probedEncoders()).toEqual(['h264_videotoolbox']);
  });

  it('bootstraps the Linux QSV probe via the VAAPI render node', async () => {
    programProbes((args) => args.includes('h264_qsv'));
    await detectHwAccel(log, 'linux');
    const qsvCall = mockExecFile.mock.calls[0][1] as string[];
    expect(qsvCall).toContain('vaapi=va:/dev/dri/renderD128');
    expect(qsvCall).toContain('qsv=qs@va');
  });
});

describe('requestedHwAccelFor', () => {
  it('forces CPU for burn-in on every non-VideoToolbox accel', () => {
    expect(
      requestedHwAccelFor('qsv', { burnIn: true, crop: false }, 'win32'),
    ).toBe('none');
    expect(
      requestedHwAccelFor('nvenc', { burnIn: true, crop: false }, 'linux'),
    ).toBe('none');
  });

  it('falls a cropped QSV encode back to VAAPI on Linux when not native', () => {
    expect(
      requestedHwAccelFor(
        'qsv',
        { burnIn: false, crop: true, qsvCanCrop: false },
        'linux',
      ),
    ).toBe('vaapi');
  });

  it('keeps a cropped QSV encode on QSV on Windows (no VAAPI to fall back to)', () => {
    expect(
      requestedHwAccelFor(
        'qsv',
        { burnIn: false, crop: true, qsvCanCrop: false },
        'win32',
      ),
    ).toBe('qsv');
  });

  it('stays on QSV when the native crop path is ready', () => {
    expect(
      requestedHwAccelFor(
        'qsv',
        { burnIn: false, crop: true, qsvCanCrop: true },
        'linux',
      ),
    ).toBe('qsv');
  });
});
