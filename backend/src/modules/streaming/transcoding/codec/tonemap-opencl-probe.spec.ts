jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs/promises', () => ({ unlink: jest.fn().mockResolvedValue(undefined), writeFile: jest.fn() }));

import { execFile } from 'child_process';
import { Logger } from '@nestjs/common';
import { hevcQsvDecoder } from './decoders/qsv';
import { hevcVaapiDecoder } from './decoders/vaapi';
import {
  isTonemapOpenclEnabled,
  isTonemapOpenclEnabledWithCrop,
  isTonemapOpenclHdr10Enabled,
  runTonemapOpenclProbe,
} from './tonemap-opencl-probe';

const mockExecFile = execFile as unknown as jest.Mock;
const log = { log: () => {} } as unknown as Logger;

function programProbes(accept: (args: string[]) => boolean): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    // The hdr-sample synthesis call has no `-vf`, so always let it through;
    // `accept` only has to judge the tonemap attempts themselves.
    if (!(args as string[]).includes('-vf') || accept(args as string[])) {
      cb(null, { stdout: '', stderr: '' });
    } else {
      cb(new Error('probe failed'));
    }
  });
}

/** Every ffmpeg invocation this run made, in call order (skips the
 *  hdr-sample synthesis call, which has no `-vf`). */
function tonemapInvocations(): string[][] {
  return mockExecFile.mock.calls
    .map((call) => call[1] as string[])
    .filter((args) => args.includes('-vf'));
}

// Order matters: the crop and hdr10 attempts are skipped once the base
// (uncropped SDR) attempt fails, so that case must run first.
describe('runTonemapOpenclProbe', () => {
  beforeEach(() => mockExecFile.mockReset());

  it('skips the crop and hdr10 attempts when the base chain fails', async () => {
    programProbes(() => false);
    await runTonemapOpenclProbe(log, 'vaapi');
    expect(tonemapInvocations()).toHaveLength(1);
    expect(isTonemapOpenclEnabled()).toBe(false);
    expect(isTonemapOpenclEnabledWithCrop()).toBe(false);
    expect(isTonemapOpenclHdr10Enabled()).toBe(false);
  });

  it('runs all three attempts once the base chain passes, using the real decoder args', async () => {
    programProbes(() => true);
    await runTonemapOpenclProbe(log, 'vaapi');
    const calls = tonemapInvocations();
    expect(calls).toHaveLength(3);
    // The VAAPI decoder descriptor's own buildInputArgs(), not a hand-rolled
    // device chain, so the probe can't drift from the real session.
    for (const args of calls) {
      expect(args).toEqual(expect.arrayContaining(hevcVaapiDecoder.buildInputArgs()));
    }
    expect(isTonemapOpenclEnabled()).toBe(true);
    expect(isTonemapOpenclEnabledWithCrop()).toBe(true);
    expect(isTonemapOpenclHdr10Enabled()).toBe(true);
    const hdr10Args = calls[2];
    expect(hdr10Args.join(' ')).toContain('apply_dovi=1');
    expect(hdr10Args.join(' ')).toContain('extra_hw_frames=24');
  });

  it('on a QSV host, uses the QSV-native decoder args (filter_hw_device qs, not a hardcoded va)', async () => {
    programProbes(() => true);
    await runTonemapOpenclProbe(log, 'qsv');
    const calls = tonemapInvocations();
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toEqual(expect.arrayContaining(hevcQsvDecoder.buildInputArgs()));
    }
  });
});
