import { Logger } from '@nestjs/common';
import { createCapabilityProbe } from './probe-utils';

function fakeLog(): Logger {
  return { log: jest.fn() } as unknown as Logger;
}

describe('createCapabilityProbe', () => {
  it('is disabled before run', () => {
    const probe = createCapabilityProbe('test-probe');
    expect(probe.isEnabled()).toBe(false);
  });

  it('enables on a successful attempt', async () => {
    const probe = createCapabilityProbe('test-probe');
    const log = fakeLog();
    const result = await probe.run(log, async () => {});
    expect(result).toBe(true);
    expect(probe.isEnabled()).toBe(true);
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('[test-probe] enabled=true'));
  });

  it('disables and logs the stderr tail on a failed attempt', async () => {
    const probe = createCapabilityProbe('test-probe');
    const log = fakeLog();
    const err = Object.assign(new Error('boom'), { stderr: 'line one\nline two\nline three' });
    const result = await probe.run(log, async () => {
      throw err;
    });
    expect(result).toBe(false);
    expect(probe.isEnabled()).toBe(false);
    expect(log.log).toHaveBeenCalledWith(
      expect.stringContaining('[test-probe] enabled=false'),
    );
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('line two line three'));
  });

  it('never rejects', async () => {
    const probe = createCapabilityProbe('test-probe');
    await expect(
      probe.run(fakeLog(), async () => {
        throw new Error('boom');
      }),
    ).resolves.toBe(false);
  });
});
