import {
  matchTimingWarnings,
  stripBenignFfmpegStderr,
} from './ffmpeg-stderr';

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

  it('drops the benign QSV→OpenCL mapping warning (unused zero-copy path)', () => {
    const raw = [
      '[OpenCL @ 0x1] The cl_intel_va_api_media_sharing extension is required for QSV to OpenCL mapping.',
      '[OpenCL @ 0x1] QSV to OpenCL mapping not usable.',
      '[vost#0:0/h264_qsv @ 0x2] frame= 100',
    ].join('\n');
    expect(stripBenignFfmpegStderr(raw)).toBe(
      '[vost#0:0/h264_qsv @ 0x2] frame= 100',
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

describe('matchTimingWarnings', () => {
  it('flags a non-monotonic DTS line (both ffmpeg spellings)', () => {
    for (const spelling of ['Non-monotonic DTS', 'Non-monotonous DTS']) {
      const raw = `[hls @ 0x1] ${spelling} in output stream 0:1; previous: 100, current: 90; changing to 100.`;
      expect(matchTimingWarnings(raw)).toEqual([
        { label: 'non-monotonic-dts', line: raw.trim() },
      ]);
    }
  });

  it('flags the invalid-increasing-dts and past-duration and backward-in-time lines', () => {
    expect(
      matchTimingWarnings(
        'Application provided invalid, non monotonically increasing dts to muxer in stream 1',
      )[0].label,
    ).toBe('invalid-increasing-dts');
    expect(
      matchTimingWarnings('[vost#0:0] Past duration 0.812 too large')[0].label,
    ).toBe('past-duration-too-large');
    expect(
      matchTimingWarnings('[aost#0:1] Queue input is backward in time')[0]
        .label,
    ).toBe('backward-in-time');
  });

  it('returns each anomaly kind at most once even across repeated lines', () => {
    const raw = [
      '[hls @ 0x1] Non-monotonic DTS; previous: 1, current: 0; changing to 1.',
      '[hls @ 0x1] Non-monotonic DTS; previous: 2, current: 1; changing to 2.',
    ].join('\n');
    expect(matchTimingWarnings(raw)).toHaveLength(1);
  });

  it('is empty on clean progress output', () => {
    expect(matchTimingWarnings('frame= 100 fps=30 q=28.0 size=1024KiB')).toEqual(
      [],
    );
  });
});
