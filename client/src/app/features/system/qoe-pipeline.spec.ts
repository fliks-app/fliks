import { describe, expect, it } from 'vitest';
import type { QoePipeline } from '../../core/services/api/qoe-api.service';
import { hintParams, loadLine, pipelineChain, pipelineParts } from './qoe-stall';

const full: QoePipeline = {
  source: { codec: 'hevc', width: 3840, height: 2160, hdr: 'HDR10' },
  output: { codec: 'h264', hdr: null, quality: '1080p-hdr', bitrate: 8_000_000 },
  decode: { hw: true, kind: 'qsv', name: 'hevc_qsv_decode' },
  encode: { hw: false, kind: 'cpu', name: 'libx264' },
  tonemap: 'opencl',
  burnIn: 'text',
  crop: true,
  audioTranscode: true,
};

describe('pipelineChain', () => {
  it('writes source to output with resolution, codec, hdr and bitrate', () => {
    expect(pipelineChain(full)).toBe('4K HEVC HDR10 → 1080p H.264 8.0 Mb/s');
  });

  it('is only the source when the stream is not re-encoded', () => {
    expect(pipelineChain({ ...full, output: null })).toBe('4K HEVC HDR10');
  });

  it('skips the unknown parts of a live transcode', () => {
    expect(
      pipelineChain({
        ...full,
        source: { codec: 'mpeg2video', width: null, height: null, hdr: null },
        output: { codec: 'h264', hdr: null, quality: null, bitrate: 4_000_000 },
      }),
    ).toBe('MPEG-2 → H.264 4.0 Mb/s');
  });
});

describe('pipelineParts', () => {
  it('lists the stages that apply, in a fixed order', () => {
    expect(pipelineParts(full).map((p) => p.key)).toEqual([
      'qoe.pipeline.tonemap',
      'qoe.pipeline.decode',
      'qoe.pipeline.encode',
      'qoe.pipeline.burn_in_text',
      'qoe.pipeline.crop',
      'qoe.pipeline.audio_transcode',
    ]);
    expect(pipelineParts(full)[0].params).toEqual({ path: 'OpenCL' });
    expect(pipelineParts(full)[2].params).toEqual({ kind: 'CPU' });
  });

  it('is empty for a plain remux', () => {
    expect(
      pipelineParts({ ...full, decode: null, encode: null, tonemap: null, burnIn: null, crop: false, audioTranscode: false }),
    ).toEqual([]);
  });
});

describe('server load and hints', () => {
  it('formats the load snapshot', () => {
    expect(loadLine({ activeTranscodes: 3, activeSessions: 5, loadAvg1: 7.84, cpuCount: 8 }).params).toEqual({
      transcodes: '3',
      sessions: '5',
      load: '7.8',
      cpus: '8',
    });
  });

  it('passes the busy count to the hint', () => {
    expect(hintParams({ data: { causeEvidence: { activeTranscodes: 3 } } })).toEqual({ count: '3' });
  });
});
