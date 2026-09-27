import type { Logger } from '@nestjs/common';
import type { ChildProcess } from 'child_process';
import {
  getPauseCapability,
  pauseProcess,
  resumeProcess,
  setPauseCapabilityForTest,
} from './ffmpeg-pause';

const log = { log() {}, warn: jest.fn(), error: jest.fn() } as unknown as Logger;

function fakeProcess(): ChildProcess {
  return {
    stdin: { write: jest.fn() },
    kill: jest.fn(),
  } as unknown as ChildProcess;
}

describe('pauseProcess / resumeProcess', () => {
  afterEach(() => jest.clearAllMocks());

  it('writes the jellyfin-ffmpeg pause/resume keys to stdin under stdin capability', () => {
    setPauseCapabilityForTest('stdin');
    const proc = fakeProcess();
    pauseProcess(proc, log);
    expect(proc.stdin!.write).toHaveBeenCalledWith('p');
    resumeProcess(proc, log);
    expect(proc.stdin!.write).toHaveBeenCalledWith('u');
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('sends SIGSTOP/SIGCONT under signal capability, never touching stdin', () => {
    setPauseCapabilityForTest('signal');
    const proc = fakeProcess();
    pauseProcess(proc, log);
    expect(proc.kill).toHaveBeenCalledWith('SIGSTOP');
    resumeProcess(proc, log);
    expect(proc.kill).toHaveBeenCalledWith('SIGCONT');
    expect(proc.stdin!.write).not.toHaveBeenCalled();
  });

  it('does nothing under "none", the caller (FfmpegThrottleService) is expected never to reach here, but a stray call must not throw', () => {
    setPauseCapabilityForTest('none');
    const proc = fakeProcess();
    expect(() => pauseProcess(proc, log)).not.toThrow();
    expect(() => resumeProcess(proc, log)).not.toThrow();
    expect(proc.kill).not.toHaveBeenCalled();
    expect(proc.stdin!.write).not.toHaveBeenCalled();
  });

  it('swallows a write/kill failure (e.g. the process already exited) instead of throwing', () => {
    setPauseCapabilityForTest('stdin');
    const proc = {
      stdin: {
        write: jest.fn(() => {
          throw new Error('EPIPE');
        }),
      },
    } as unknown as ChildProcess;
    expect(() => pauseProcess(proc, log)).not.toThrow();
  });

  it('setPauseCapabilityForTest is reflected by getPauseCapability', () => {
    setPauseCapabilityForTest('signal');
    expect(getPauseCapability()).toBe('signal');
    setPauseCapabilityForTest('stdin');
    expect(getPauseCapability()).toBe('stdin');
  });
});
