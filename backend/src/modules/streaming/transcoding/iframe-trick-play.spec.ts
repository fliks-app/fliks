import {
  buildIFrameSegmentArgs,
  iframeBandwidthBps,
  iframeResolution,
} from './iframe-trick-play';

describe('iframeResolution', () => {
  it('caps the height at 720 and keeps the aspect', () => {
    expect(iframeResolution(3840, 2160)).toEqual({ width: 1280, height: 720 });
  });

  it('leaves a smaller source alone', () => {
    expect(iframeResolution(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('keeps both axes even for yuv420p', () => {
    // 1918x872 scope crop: the width scales to an odd value before rounding.
    const { width, height } = iframeResolution(1918, 1081);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});

describe('buildIFrameSegmentArgs', () => {
  const base = {
    inputPath: '/media/file.mkv',
    seekSeconds: 24,
    width: 1280,
    height: 720,
  };

  it('seeks before the input and keeps the source timestamps', () => {
    const args = buildIFrameSegmentArgs(base);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-copyts');
  });

  it('emits exactly one frame as MPEG-TS on stdout', () => {
    const args = buildIFrameSegmentArgs(base);
    expect(
      args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2),
    ).toEqual(['-frames:v', '1']);
    expect(args[args.length - 1]).toBe('pipe:1');
    expect(args[args.indexOf('-f') + 1]).toBe('mpegts');
  });

  it('crops before scaling so the frame keeps the variant aspect', () => {
    const args = buildIFrameSegmentArgs({
      ...base,
      crop: { width: 1920, height: 800, x: 0, y: 140 },
    });
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'crop=1920:800:0:140,scale=1280:720',
    );
  });
});

describe('iframeBandwidthBps', () => {
  it('scales with the grid', () => {
    expect(iframeBandwidthBps(4)).toBeGreaterThan(iframeBandwidthBps(8));
  });
});
