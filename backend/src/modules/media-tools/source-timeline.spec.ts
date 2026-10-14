import { Logger } from '@nestjs/common';
import {
  inputSeekSeconds,
  sourceTimeline,
  videoPresentationStart,
} from './source-timeline';

describe('sourceTimeline', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  beforeEach(() => warn.mockClear());

  it('anchors on the first presented frame, not the first packet', () => {
    // A recording cut mid-GOP: packets from 15.0, first decodable frame 15.8.
    const t = sourceTimeline(
      {
        formatStartSeconds: 14.94,
        video: [{ streamIndex: 0, codec: 'h264', startTimeSeconds: 15, firstFrameSeconds: 15.8 }],
      },
      'pvr',
    );
    expect(t).toEqual({ origin: 15.8, formatStart: 14.94 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the video start_time for a row probed without the new fields, and says so once', () => {
    const si = { video: [{ streamIndex: 0, codec: 'h264', startTimeSeconds: 2.8 }] };
    expect(sourceTimeline(si, 'old-row')).toEqual({ origin: 2.8, formatStart: 2.8 });
    sourceTimeline(si, 'old-row');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is 0/0 without stream info', () => {
    expect(sourceTimeline(null)).toEqual({ origin: 0, formatStart: 0 });
    expect(sourceTimeline({ video: [], formatStartSeconds: 0 })).toEqual({ origin: 0, formatStart: 0 });
  });

  it('falls back to the first packet for the presentation start', () => {
    expect(videoPresentationStart({ startTimeSeconds: 1.2 })).toBe(1.2);
    expect(videoPresentationStart({ startTimeSeconds: 1.2, firstFrameSeconds: 1.6 })).toBe(1.6);
    expect(videoPresentationStart(undefined)).toBeUndefined();
  });
});

describe('inputSeekSeconds', () => {
  it('counts from the container start, which precedes a late video', () => {
    // Video at 4.2, audio (the container start) at 3.18: content 6 s is source 10.2.
    expect(inputSeekSeconds(6, { origin: 4.2, formatStart: 3.18 })).toBeCloseTo(7.02, 9);
  });

  it('is the content position when the video starts the container', () => {
    expect(inputSeekSeconds(6, { origin: 2.8, formatStart: 2.8 })).toBe(6);
  });
});
