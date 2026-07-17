import { stripBenignFfmpegStderr } from './ffmpeg-stderr';

describe('stripBenignFfmpegStderr', () => {
  it('drops PGS/VOBSUB subtitle codec-parameter warnings and their hint', () => {
    const raw = [
      "[in#0/matroska,webm @ 0x1] Could not find codec parameters for stream 5 (Subtitle: hdmv_pgs_subtitle (pgssub)): unspecified size",
      "Consider increasing the value for the 'analyzeduration' (0) and 'probesize' (5000000) options",
      "[in#0/matroska,webm @ 0x1] Could not find codec parameters for stream 6 (Subtitle: dvd_subtitle): unspecified size",
      "Consider increasing the value for the 'analyzeduration' (0) and 'probesize' (5000000) options",
    ].join('\n');
    expect(stripBenignFfmpegStderr(raw)).toBe('');
  });

  it('keeps the real error while dropping the surrounding subtitle noise', () => {
    const raw = [
      '[in#0/matroska,webm @ 0x1] Could not find codec parameters for stream 5 (Subtitle: hdmv_pgs_subtitle (pgssub)): unspecified size',
      "Consider increasing the value for the 'analyzeduration' (0) and 'probesize' (5000000) options",
      '[vf#0:0 @ 0x2] Task finished with error code: -17 (File exists)',
      '[vost#0:0/h264_qsv @ 0x3] Could not open encoder before EOF',
    ].join('\n');
    expect(stripBenignFfmpegStderr(raw)).toBe(
      [
        '[vf#0:0 @ 0x2] Task finished with error code: -17 (File exists)',
        '[vost#0:0/h264_qsv @ 0x3] Could not open encoder before EOF',
      ].join('\n'),
    );
  });

  it('leaves a codec-param warning for a non-subtitle stream untouched', () => {
    const raw =
      '[in#0/matroska,webm @ 0x1] Could not find codec parameters for stream 0 (Video: hevc): unspecified size';
    expect(stripBenignFfmpegStderr(raw)).toBe(raw);
  });

  it('is a no-op on clean stderr', () => {
    const raw = 'frame= 100 fps=30 q=28.0 size=1024KiB';
    expect(stripBenignFfmpegStderr(raw)).toBe(raw);
  });
});
