import type { HwAccelType } from '../../types';
import type { BitDepth, VideoCodec } from '../types';

/** Where the decoder lands its output frames. The orchestrator uses
 *  this to compute the bridge filter that turns a decoder surface into
 *  the format the encoder expects (see `surfaceBridge`).
 *
 *  - `'cpu'`         : software frames (e.g. yuv420p in main memory)
 *  - `'vaapi'`       : libva surface, lives in iGPU/dGPU memory
 *  - `'qsv'`         : Intel Media SDK QSV surface (sibling of vaapi
 *                      but a different libavutil hwcontext)
 *  - `'cuda'`        : NVIDIA CUDA surface
 *  - `'videotoolbox'`: macOS IOSurface produced by VT decode (we keep
 *                      the descriptor's `outputSurface` at `'cpu'` for
 *                      now because the rest of the pipeline expects
 *                      software frames on VT; future work can lift
 *                      that constraint). */
export type SurfaceFormat = 'cpu' | 'vaapi' | 'qsv' | 'cuda' | 'videotoolbox';

/** Just enough source-side metadata for the decoder selector. Populated
 *  from ffprobe streamInfo at session-spawn time. */
export interface DecoderSourceInfo {
  codec: VideoCodec;
  bitDepth: BitDepth;
}

/** A single decoder binding — one ffmpeg decoder × one platform × one
 *  source codec. Mirror of `EncoderDescriptor`: the orchestrator owns
 *  no codec-specific decode logic, every quirk lives in one descriptor
 *  file under `./decoders/`. */
export interface DecoderDescriptor {
  /** Stable identifier surfaced in logs and the boot probe summary
   *  (e.g. `'hevc_qsv_decode'`). */
  readonly id: string;
  readonly hwAccel: HwAccelType;
  /** Source codec this descriptor decodes. `'any'` covers the CPU
   *  software path which handles every codec ffmpeg knows. */
  readonly sourceCodec: VideoCodec | 'any';
  /** Maximum source bit-depth this decoder can ingest. 10 covers 8 too. */
  readonly maxBitDepth: BitDepth;
  /** Surface format on the output side of the decode. Drives the
   *  bridge filter we splice in front of the encoder. */
  readonly outputSurface: SurfaceFormat;
  /** Soft host-level capability check (e.g. `process.platform === 'darwin'`
   *  for VideoToolbox). Runs build-time / sync. The runtime probe in
   *  `decoder-probe.ts` is the second gate that catches missing
   *  drivers, kernel modules and similar. */
  supports(): boolean;
  /** ffmpeg input args slice — `-hwaccel`, `-hwaccel_output_format`,
   *  `-init_hw_device`, `-filter_hw_device`. Inserted before `-i` in
   *  the orchestrator's `buildFfmpegArgs`. Does NOT include `-i`
   *  itself or any input-only `-ss`/`-t` — those stay with the
   *  orchestrator. */
  buildInputArgs(): string[];
}

/** Selector / lookup over the registered decoders. */
export interface DecoderRegistry {
  /** Pick the preferred decoder for `source`, biased toward staying
   *  on `preferredHwAccel` so the decoder and encoder share a device
   *  and the surface bridge is empty. Falls back to CPU decode when
   *  no HW decoder matches. Never returns `null` — `cpu` always
   *  qualifies for any codec ffmpeg understands. */
  resolve(
    source: DecoderSourceInfo,
    preferredHwAccel: HwAccelType,
  ): DecoderDescriptor;
}
