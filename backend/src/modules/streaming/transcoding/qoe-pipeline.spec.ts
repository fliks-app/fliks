import { encodePipelineInputs } from './encode-pipeline';
import { describeQoePipeline, type QoePipelineFacts } from './qoe-pipeline';

const source = { codec: 'hevc', width: 3840, height: 2160, hdr: 'HDR10' as const };
const facts = (o: Partial<QoePipelineFacts> = {}): QoePipelineFacts => ({
  playMethod: 'Transcode',
  source,
  variant: { codec: 'h264', bitDepth: 8, hdr: null },
  quality: '1080p',
  videoBitrateBps: 8_000_000,
  inputs: encodePipelineInputs({
    hwAccel: 'none',
    crop: true,
    textBurnIn: true,
    tonemap: true,
    tonemapAlgo: 'auto',
    sourceVideoCodec: 'hevc',
    isSourceHdr: true,
    sourceDvProfile: null,
    sourceDvBlSignalCompatId: null,
  }),
  tonemapPath: 'cpu',
  burnIn: 'text',
  crop: true,
  audioTranscode: true,
  ...o,
});

describe('describeQoePipeline', () => {
  it('describes a software transcode end to end', () => {
    const p = describeQoePipeline(facts());
    expect(p).toMatchObject({
      source,
      output: { codec: 'h264', hdr: null, quality: '1080p', bitrate: 8_000_000 },
      decode: { hw: false, kind: 'cpu' },
      encode: { hw: false, kind: 'cpu' },
      tonemap: 'cpu',
      burnIn: 'text',
      crop: true,
      audioTranscode: true,
    });
    expect(p.encode?.name).toEqual(expect.any(String));
  });

  it('keeps only the source for a stream that is not re-encoded', () => {
    expect(describeQoePipeline(facts({ playMethod: 'DirectStream', audioTranscode: false }))).toEqual({
      source,
      output: null,
      decode: null,
      encode: null,
      tonemap: null,
      burnIn: null,
      crop: null,
      audioTranscode: false,
    });
    expect(describeQoePipeline(facts({ playMethod: 'DirectPlay' })).audioTranscode).toBeNull();
  });
});
