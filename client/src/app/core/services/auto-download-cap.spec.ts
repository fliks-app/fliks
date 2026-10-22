import { describe, expect, it } from 'vitest';
import { autoCapReached } from './auto-download-cap';

const GB = 1024 ** 3;

describe('autoCapReached', () => {
  it('never caps at 0', () => {
    expect(autoCapReached([{ auto: true, sizeBytes: 99 * GB }], 0)).toBe(false);
  });

  it('counts auto downloads only', () => {
    const tasks = [{ auto: true, sizeBytes: 3 * GB }, { sizeBytes: 50 * GB }, { auto: true }];
    expect(autoCapReached(tasks, 4)).toBe(false);
    expect(autoCapReached(tasks, 3)).toBe(true);
  });
});
