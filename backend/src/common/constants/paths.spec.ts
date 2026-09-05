import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('TRANSCODE_DIR', () => {
  const OLD_ENV = process.env;
  const OLD_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;

  afterEach(() => {
    process.env = OLD_ENV;
    Object.defineProperty(process, 'platform', OLD_PLATFORM);
    jest.resetModules();
  });

  function loadWith(
    platform: NodeJS.Platform,
    override?: string,
  ): string {
    jest.resetModules();
    process.env = { ...OLD_ENV, FLIKS_TRANSCODE_DIR: override };
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
    return require('./paths').TRANSCODE_DIR as string;
  }

  it('defaults to /tmp/transcode on Linux', () => {
    expect(loadWith('linux')).toBe('/tmp/transcode');
  });

  it('falls back to the OS temp dir on Windows', () => {
    const dir = loadWith('win32');
    expect(dir.endsWith('fliks-transcode')).toBe(true);
    expect(dir).toContain(os.tmpdir());
  });

  it('honours FLIKS_TRANSCODE_DIR on any platform', () => {
    expect(loadWith('win32', '/data/scratch')).toBe('/data/scratch');
    expect(loadWith('linux', '/data/scratch')).toBe('/data/scratch');
  });
});

describe('getDataDir', () => {
  const OLD_ENV = process.env;
  let cwd: string;
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fliks-datadir-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
  });

  afterEach(() => {
    process.env = OLD_ENV;
    cwdSpy.mockRestore();
    fs.rmSync(cwd, { recursive: true, force: true });
    jest.resetModules();
  });

  function load(env: Record<string, string | undefined> = {}): string {
    process.env = { ...OLD_ENV, ...env };
    return (require('./paths') as typeof import('./paths')).getDataDir();
  }

  it('defaults to data/ under the working directory', () => {
    expect(load()).toBe(path.join(cwd, 'data'));
  });

  it('honours FLIKS_DATA_DIR', () => {
    const dir = path.join(cwd, 'elsewhere');
    expect(load({ FLIKS_DATA_DIR: dir })).toBe(dir);
  });

  // An install that upgrades without editing its compose file: the volume is
  // still mounted at images/, and its avatars are not re-fetchable.
  it('keeps using images/ when a volume is still mounted there', () => {
    fs.mkdirSync(path.join(cwd, 'images'));
    expect(load()).toBe(path.join(cwd, 'images'));
  });

  it('prefers data/ once images/ is gone', () => {
    expect(load()).toBe(path.join(cwd, 'data'));
  });

  it('still accepts the deprecated FLIKS_IMAGES_DIR', () => {
    const dir = path.join(cwd, 'legacy-override');
    expect(load({ FLIKS_IMAGES_DIR: dir })).toBe(dir);
  });

  it('lets FLIKS_DATA_DIR win over the deprecated variable', () => {
    const dir = path.join(cwd, 'wins');
    expect(load({ FLIKS_DATA_DIR: dir, FLIKS_IMAGES_DIR: path.join(cwd, 'loses') })).toBe(dir);
  });
});
