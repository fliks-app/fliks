import * as os from 'os';

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
