import type { PipelineStage, QoePipeline } from '../../qoe/core/types';
import type { PlayMethod } from '../dto/playback-info.dto';
import type { CodecVariant } from './codec/types';
import {
  resolveEncodePipeline,
  type EncodePipelineContext,
  type TonemapReportPath,
} from './encode-pipeline';
import { pickDecoder } from './ffmpeg-args';
import type { HwAccelType } from './types';

export interface QoePipelineFacts {
  playMethod: PlayMethod;
  source: QoePipeline['source'];
  /** The output variant of a transcode; null otherwise. */
  variant: CodecVariant | null;
  quality: string | null;
  requested: string | null;
  videoBitrateBps: number | null;
  inputs: EncodePipelineContext;
  tonemapPath: TonemapReportPath | null;
  burnIn: 'text' | 'image' | null;
  crop: boolean;
  audioTranscode: boolean;
}

const stage = (hw: HwAccelType, name: string | null): PipelineStage => ({
  hw: hw !== 'none',
  kind: hw === 'none' ? 'cpu' : hw,
  name,
});

/** What the server does to the stream, from the same resolvers the spawn uses. */
export function describeQoePipeline(f: QoePipelineFacts): QoePipeline {
  if (f.playMethod !== 'Transcode' || !f.variant) {
    return {
      source: f.source,
      output: null,
      decode: null,
      encode: null,
      tonemap: null,
      burnIn: null,
      crop: null,
      audioTranscode: f.playMethod === 'DirectPlay' ? null : f.audioTranscode,
    };
  }
  const p = resolveEncodePipeline(f.variant, f.inputs);
  const decoder = pickDecoder({
    sourceVideoCodec: f.inputs.sourceVideoCodec,
    qsvNative: p.qsvNative,
    amfOpenclAvailable: p.amfOpenclAvailable,
    effectiveHwAccel: p.effectiveHwAccel,
    decodeHwAccel: p.effectiveHwAccel,
    sourceBitDepth: f.inputs.sourceBitDepth,
  });
  return {
    source: f.source,
    output: {
      codec: f.variant.codec,
      hdr: f.variant.hdr,
      quality: f.quality,
      requested: f.requested,
      bitrate: f.videoBitrateBps,
    },
    decode: stage(decoder.hwAccel, decoder.id),
    encode: stage(p.effectiveHwAccel, p.encoder?.id ?? null),
    tonemap: f.tonemapPath,
    burnIn: f.burnIn,
    crop: f.crop,
    audioTranscode: f.audioTranscode,
  };
}
