import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { resolveWritableDir } from './writable-dir';

describe('resolveWritableDir', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'writable-dir-test-'));
  });

  afterEach(() => {
    chmodSync(tmpRoot, 0o700);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the first writable candidate without warning', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const dir = path.join(tmpRoot, 'ok');

    const result = resolveWritableDir([dir, path.join(tmpRoot, 'unused')], 'warning');

    expect(result).toBe(dir);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to the next candidate and warns when the first is unwritable', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const blocked = path.join(tmpRoot, 'blocked');
    mkdirSync(blocked, { mode: 0o500 });
    const fallback = path.join(tmpRoot, 'fallback');

    const result = resolveWritableDir([blocked, fallback], 'fallback warning');

    expect(result).toBe(fallback);
    expect(existsSync(fallback)).toBe(true);
    expect(warn).toHaveBeenCalledWith('fallback warning');
    warn.mockRestore();
  });
});
