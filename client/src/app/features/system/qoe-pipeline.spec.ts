import { describe, expect, it } from 'vitest';
import type { QoePipeline } from '../../core/services/api/qoe-api.service';
import { hintParams, loadLine, pipelineChain, pipelineParts, qualityLabel, type Fmt } from './qoe-stall';

const f: Fmt = {
  n: (v, d = 1) => v.toFixed(d),
  t: (key, p = {}) =>
    key === 'qoe.mbps' ? `${p['value']} Mbps` : key === 'qoe.pipeline.res_p' ? `${p['height']}p` : key === 'qoe.pipeline.rung' ? `tier ${p['name']}` : key === 'qoe.pipeline.auto' ? 'auto' : key,
};

const full: QoePipeline = {
  source: { codec: 'hevc', width: 3840, height: 1588, hdr: 'DV' },
  output: { codec: 'h264', hdr: null, quality: '1080p-hdr', bitrate: 8_000_000, requested: '1080p' },
  decode: { hw: true, kind: 'qsv', name: 'hevc_qsv_decode' },
  encode: { hw: false, kind: 'cpu', name: 'libx264' },
  tonemap: 'opencl',
  burnIn: 'text',
  crop: true,
  audioTranscode: true,
};

describe('pipelineChain', () => {
  it('writes source to output with resolution, codec, hdr and bitrate', () => {
    expect(pipelineChain(full, f)).toBe('3840×1588 HEVC Dolby Vision → tier 1080p H.264 8.0 Mbps');
  });

  it('is only the source when the stream is not re-encoded', () => {
    expect(pipelineChain({ ...full, output: null }, f)).toBe('3840×1588 HEVC Dolby Vision');
  });

  it('skips the unknown parts of a live transcode', () => {
    expect(
      pipelineChain(
        {
          ...full,
          source: { codec: 'mpeg2video', width: null, height: null, hdr: null },
          output: { codec: 'h264', hdr: null, quality: 'auto', bitrate: 4_000_000, requested: null },
        },
        f,
      ),
    ).toBe('MPEG-2 → H.264 4.0 Mbps');
  });
});

describe('pipelineChain output', () => {
  it('shows the real output size with the rung as a tier, and what auto resolved to', () => {
    const auto = { ...full, output: { ...full.output!, quality: '2160p', requested: 'auto' } };
    expect(pipelineChain(auto, f, { width: 3840, height: 1588 })).toBe(
      '3840×1588 HEVC Dolby Vision → auto → 3840×1588 (tier 2160p) H.264 8.0 Mbps',
    );
    expect(pipelineChain({ ...auto, output: { ...auto.output, quality: null } }, f)).toBe(
      '3840×1588 HEVC Dolby Vision → auto → H.264 8.0 Mbps',
    );
  });

  it('labels the quality column with what auto served', () => {
    const row = { quality: 'auto', pipeline: { ...full, output: { ...full.output!, quality: '2160p-hdr' } } };
    expect(qualityLabel(row, f)).toBe('auto → 2160p');
    expect(qualityLabel({ quality: null, pipeline: { ...full, output: { ...full.output!, quality: null, requested: 'auto' } } }, f)).toBe('auto');
    expect(qualityLabel({ quality: '720p', pipeline: null }, f)).toBe('720p');
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

  it('leaves the load average out when the server has none', () => {
    expect(loadLine({ activeTranscodes: 1, activeSessions: 2, loadAvg1: null, cpuCount: 4 }).key).toBe('qoe.pipeline.load_no_avg');
  });

  it('passes the busy count to the hint', () => {
    expect(hintParams({ data: { causeEvidence: { activeTranscodes: 3 } } })).toEqual({ count: '3' });
  });
});
