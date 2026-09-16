import { buildLiveFfmpegArgs, type LiveFfmpegArgsOptions } from './live-ffmpeg-args';
import { LIVETV_USER_AGENT } from '../livetv-http';

function base(overrides: Partial<LiveFfmpegArgsOptions> = {}): LiveFfmpegArgsOptions {
  return {
    inputUrl: 'http://provider.example/live/1.ts',
    outputDir: '/tmp/transcode/live/1-remux',
    segmentSeconds: 2,
    windowMinutes: 5,
    mode: 'remux',
    useTs: false,
    hwAccel: 'none',
    ...overrides,
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe('buildLiveFfmpegArgs', () => {
  it('always sets the reconnect / resilience input flags', () => {
    const args = buildLiveFfmpegArgs(base());
    expect(flagValue(args, '-reconnect')).toBe('1');
    expect(flagValue(args, '-reconnect_streamed')).toBe('1');
    expect(flagValue(args, '-reconnect_on_network_error')).toBe('1');
    expect(flagValue(args, '-reconnect_delay_max')).toBe('5');
    expect(flagValue(args, '-rw_timeout')).toBe('15000000');
  });

  it('re-encodes an audio codec the browser refuses', () => {
    const args = buildLiveFfmpegArgs(base({ mode: 'remux', audioCodec: 'mp2' }));
    expect(flagValue(args, '-c:v')).toBe('copy');
    expect(flagValue(args, '-c:a')).toBe('aac');
  });

  it('re-encodes audio on transcode too when it is not AAC', () => {
    const args = buildLiveFfmpegArgs(
      base({ mode: 'transcode', hwAccel: 'none', audioCodec: 'ac3' }),
    );
    expect(flagValue(args, '-c:v')).toBe('libx264');
    expect(flagValue(args, '-c:a')).toBe('aac');
  });

  it('copies AAC rather than re-encoding it, and converts ADTS for fMP4', () => {
    // Measured: re-encoding puts the audio 22 ms ahead, the encoder's priming delay.
    const args = buildLiveFfmpegArgs(base({ mode: 'remux', audioCodec: 'aac' }));
    expect(flagValue(args, '-c:a')).toBe('copy');
    expect(flagValue(args, '-bsf:a')).toBe('aac_adtstoasc');
  });

  it('leaves ADTS alone when the segments are TS', () => {
    const args = buildLiveFfmpegArgs(base({ mode: 'remux', audioCodec: 'aac', useTs: true }));
    expect(flagValue(args, '-c:a')).toBe('copy');
    expect(args).not.toContain('-bsf:a');
  });

  it('re-encodes when the codec is unknown, rather than assuming', () => {
    const args = buildLiveFfmpegArgs(base({ mode: 'remux' }));
    expect(flagValue(args, '-c:a')).toBe('aac');
  });

  it('never overrides the timestamps a live source already carries', () => {
    const args = buildLiveFfmpegArgs(base({ mode: 'remux' }));
    expect(args).not.toContain('-fflags');
  });

  it('never asks the muxer to emit before the first video keyframe', () => {
    // nobuffer / low_delay open a session with a 2 s audio-only head, measured.
    const args = buildLiveFfmpegArgs(base({ mode: 'remux' }));
    expect(args.join(' ')).not.toContain('nobuffer');
    expect(args.join(' ')).not.toContain('low_delay');
  });

  it('picks the hwaccel-specific encoder and input flags', () => {
    const qsv = buildLiveFfmpegArgs(base({ mode: 'transcode', hwAccel: 'qsv' }));
    expect(flagValue(qsv, '-c:v')).toBe('h264_qsv');
    expect(flagValue(qsv, '-hwaccel')).toBe('qsv');
    expect(flagValue(qsv, '-hwaccel_output_format')).toBe('qsv');

    const nvenc = buildLiveFfmpegArgs(base({ mode: 'transcode', hwAccel: 'nvenc' }));
    expect(flagValue(nvenc, '-c:v')).toBe('h264_nvenc');
    expect(flagValue(nvenc, '-hwaccel')).toBe('cuda');

    const amf = buildLiveFfmpegArgs(base({ mode: 'transcode', hwAccel: 'amf' }));
    expect(flagValue(amf, '-c:v')).toBe('h264_amf');
    expect(amf).not.toContain('-hwaccel');
  });

  it('sets delete_segments and program_date_time', () => {
    const args = buildLiveFfmpegArgs(base());
    const flags = flagValue(args, '-hls_flags') ?? '';
    expect(flags).toContain('delete_segments');
    expect(flags).toContain('program_date_time');
  });

  it('adds append_list+discont_start only when append is true', () => {
    const fresh = flagValue(buildLiveFfmpegArgs(base()), '-hls_flags') ?? '';
    expect(fresh).not.toContain('append_list');
    expect(fresh).not.toContain('discont_start');

    const appended = flagValue(buildLiveFfmpegArgs(base({ append: true })), '-hls_flags') ?? '';
    expect(appended).toContain('append_list');
    expect(appended).toContain('discont_start');
  });

  it('switches segment type and extension together for the TS flavour', () => {
    const fmp4 = buildLiveFfmpegArgs(base({ useTs: false }));
    expect(flagValue(fmp4, '-hls_segment_type')).toBe('fmp4');
    expect(flagValue(fmp4, '-hls_segment_filename')).toMatch(/\.m4s$/);
    expect(flagValue(fmp4, '-hls_fmp4_init_filename')).toBe('init.mp4');

    const ts = buildLiveFfmpegArgs(base({ useTs: true }));
    expect(flagValue(ts, '-hls_segment_type')).toBe('mpegts');
    expect(flagValue(ts, '-hls_segment_filename')).toMatch(/\.ts$/);
    expect(ts).not.toContain('-hls_fmp4_init_filename');
  });

  it('never maps subtitle/data streams and takes at most one audio track', () => {
    const args = buildLiveFfmpegArgs(base());
    expect(args).toContain('-sn');
    expect(args).toContain('-dn');
    const mapIndexes = args.reduce<number[]>((acc, v, i) => {
      if (v === '-map') acc.push(i);
      return acc;
    }, []);
    expect(mapIndexes.map((i) => args[i + 1])).toEqual(['0:v:0', '0:a:0?']);
  });

  it('derives hls_list_size from the timeshift window and segment length', () => {
    const args = buildLiveFfmpegArgs(base({ segmentSeconds: 2, windowMinutes: 5 }));
    expect(flagValue(args, '-hls_list_size')).toBe('150');
  });

  it('never emits -start_number, even on an append respawn', () => {
    const args = buildLiveFfmpegArgs(base({ append: true }));
    expect(args).not.toContain('-start_number');
  });

  it('defaults the probe window to 3s / 5MB and never narrows below that floor', () => {
    const args = buildLiveFfmpegArgs(base());
    expect(flagValue(args, '-analyzeduration')).toBe('3000000');
    expect(flagValue(args, '-probesize')).toBe('5000000');

    const narrowed = buildLiveFfmpegArgs(base({ probeSeconds: 1 }));
    expect(flagValue(narrowed, '-analyzeduration')).toBe('3000000');
    expect(flagValue(narrowed, '-probesize')).toBe('5000000');
  });

  it('widens the probe window proportionally for a long-GOP feed', () => {
    const args = buildLiveFfmpegArgs(base({ probeSeconds: 6 }));
    expect(flagValue(args, '-analyzeduration')).toBe('6000000');
    expect(flagValue(args, '-probesize')).toBe('10000000');
  });

  it('falls back to the shared Live TV user agent when the source has none', () => {
    // Providers block ffmpeg's own default outright.
    const args = buildLiveFfmpegArgs(base());
    expect(flagValue(args, '-user_agent')).toBe(LIVETV_USER_AGENT);
  });

  it('forwards user-agent and referer as ffmpeg input options', () => {
    const args = buildLiveFfmpegArgs(
      base({ userAgent: 'FliksLiveTv/1.0', referer: 'http://provider.example/' }),
    );
    expect(flagValue(args, '-user_agent')).toBe('FliksLiveTv/1.0');
    expect(flagValue(args, '-headers')).toBe('Referer: http://provider.example/\r\n');
  });
});
