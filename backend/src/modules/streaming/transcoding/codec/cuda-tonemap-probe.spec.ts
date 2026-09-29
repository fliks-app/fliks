jest.mock('child_process', () => ({ execFile: jest.fn() }));

import { execFile } from 'child_process';
import { Logger } from '@nestjs/common';
import {
  isCudaTonemapEnabled,
  isCudaTonemapHdr10Enabled,
  runCudaTonemapProbe,
} from './cuda-tonemap-probe';

const mockExecFile = execFile as unknown as jest.Mock;
const log = { log: () => {} } as unknown as Logger;

/** Succeed only for a `-vf` string matching `accept`. */
function programProbes(accept: (vf: string) => boolean): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    const vf = (args as string[])[(args as string[]).indexOf('-vf') + 1];
    if (accept(vf)) cb(null, { stdout: '', stderr: '' });
    else cb(new Error('probe failed'));
  });
}

// Order matters: isCudaTonemapHdr10Enabled() is a module-level flag that only
// changes when its attempt actually runs, so the "skipped" case must come
// first, before any later test drives it true.
describe('runCudaTonemapProbe', () => {
  beforeEach(() => mockExecFile.mockReset());

  it('skips the HDR10 attempt entirely when the SDR recipe fails', async () => {
    programProbes(() => false);
    await runCudaTonemapProbe(log);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(isCudaTonemapEnabled()).toBe(false);
    expect(isCudaTonemapHdr10Enabled()).toBe(false);
  });

  it('the SDR flag can be enabled while the HDR10 recipe independently fails', async () => {
    programProbes((vf) => vf.includes('apply_dovi=0'));
    await runCudaTonemapProbe(log);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(isCudaTonemapEnabled()).toBe(true);
    expect(isCudaTonemapHdr10Enabled()).toBe(false);
  });

  it('probes the SDR recipe first, then the HDR10 recipe (apply_dovi=1) second', async () => {
    programProbes(() => true);
    await runCudaTonemapProbe(log);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const [sdrVf, hdr10Vf] = mockExecFile.mock.calls.map(
      (call) => (call[1] as string[])[(call[1] as string[]).indexOf('-vf') + 1],
    );
    expect(sdrVf).toContain('apply_dovi=0');
    expect(hdr10Vf).toContain('apply_dovi=1');
    expect(hdr10Vf).toContain('format=p010:t=smpte2084');
    expect(isCudaTonemapEnabled()).toBe(true);
    expect(isCudaTonemapHdr10Enabled()).toBe(true);
  });
});
