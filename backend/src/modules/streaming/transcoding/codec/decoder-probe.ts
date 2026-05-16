import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { unlink, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { DecoderDescriptor } from './decoders/types';
import type { VideoCodec } from './types';

const execFileAsync = promisify(execFile);

/** Decoder probe results, populated once at boot by `runDecoderProbes()`.
 *  Read by the registry's `isUsable` gate. Same shape and semantics as
 *  the encoder probe. */
const probeResult = new Map<string, boolean>();
let probedOnce = false;

/** Default-true before the first probe wave finishes (services that
 *  resolve a decoder during the brief boot window pre-probe get the CPU
 *  fallback if the HW choice ends up disabled). Once the probe has run,
 *  the explicit map wins. */
export function isDecoderEnabled(descriptorId: string): boolean {
  if (!probedOnce) return true;
  return probeResult.get(descriptorId) ?? false;
}

/** Walk every decoder descriptor: synthesize a 1-frame bitstream in the
 *  matching codec via a CPU encoder, then decode it with the descriptor
 *  under test. HW decoders run strictly serially because Intel iGPUs
 *  reject concurrent VAAPI/QSV contexts at boot (same pattern that
 *  produced the encoder-probe false negatives). CPU decoders run in
 *  parallel — no shared state. */
export async function runDecoderProbes(
  descriptors: readonly DecoderDescriptor[],
  log: Logger,
): Promise<void> {
  const t0 = Date.now();

  // Pre-generate one tiny test bitstream per source codec we'll probe.
  // Re-using the same file across all decoders of that codec keeps the
  // probe cheap and deterministic.
  const codecs = new Set<VideoCodec>();
  for (const d of descriptors) {
    if (d.sourceCodec !== 'any') codecs.add(d.sourceCodec);
  }
  const samples = await prepareSampleBitstreams([...codecs]);

  const cpuDescriptors: DecoderDescriptor[] = [];
  const hwDescriptors: DecoderDescriptor[] = [];
  for (const d of descriptors) {
    (d.hwAccel === 'none' ? cpuDescriptors : hwDescriptors).push(d);
  }

  const runOne = async (
    d: DecoderDescriptor,
  ): Promise<{ id: string; ok: boolean }> => {
    if (!d.supports()) {
      probeResult.set(d.id, false);
      return { id: d.id, ok: false };
    }
    // `'any'` (CPU software path) just needs to verify ffmpeg can run.
    // We pick any sample for that — h264 is the safest bet (every
    // ffmpeg build has libavcodec h264).
    const samplePath =
      d.sourceCodec === 'any'
        ? (samples.get('h264') ?? null)
        : (samples.get(d.sourceCodec) ?? null);
    if (!samplePath) {
      probeResult.set(d.id, false);
      return { id: d.id, ok: false };
    }
    const ok = await probeOne(d, samplePath);
    probeResult.set(d.id, ok);
    return { id: d.id, ok };
  };

  const cpuTask = Promise.all(cpuDescriptors.map(runOne));
  const hwTask = (async () => {
    const out: { id: string; ok: boolean }[] = [];
    for (const d of hwDescriptors) out.push(await runOne(d));
    return out;
  })();

  const settled = (await Promise.all([cpuTask, hwTask])).flat();

  // Cleanup the temp samples — best-effort, never throws.
  await Promise.all(
    [...samples.values()].map((p) => unlink(p).catch(() => {})),
  );

  probedOnce = true;
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const r of settled) (r.ok ? enabled : disabled).push(r.id);
  log.log(
    `[decoder-probe] ${enabled.length}/${descriptors.length} enabled (${Date.now() - t0}ms): ${enabled.join(',')}${disabled.length ? ` | disabled: ${disabled.join(',')}` : ''}`,
  );
}

/** Encode a tiny single-frame bitstream for each codec we need to probe.
 *  Returns a map from codec → tmpfile path. Missing entries mean the CPU
 *  encoder for that codec is missing from this ffmpeg build, which
 *  cascades to "no decoder probe for that codec ran" — fine, those
 *  descriptors stay disabled and the runtime falls back to CPU decode. */
async function prepareSampleBitstreams(
  codecs: VideoCodec[],
): Promise<Map<VideoCodec, string>> {
  const samples = new Map<VideoCodec, string>();
  const encoderFor: Record<VideoCodec, { codec: string; ext: string }> = {
    h264: { codec: 'libx264', ext: 'h264' },
    hevc: { codec: 'libx265', ext: 'hevc' },
    av1: { codec: 'libsvtav1', ext: 'ivf' },
  };
  for (const codec of codecs) {
    const cfg = encoderFor[codec];
    if (!cfg) continue;
    const out = path.join(
      os.tmpdir(),
      `fliks-decoder-probe-${codec}-${process.pid}.${cfg.ext}`,
    );
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'nullsrc=size=320x180:rate=30',
          '-frames:v',
          '1',
          '-c:v',
          cfg.codec,
          '-pix_fmt',
          'yuv420p',
          out,
        ],
        { timeout: 10_000 },
      );
      samples.set(codec, out);
    } catch {
      // Encoder missing in this ffmpeg build — leave the codec out of
      // the map. Decoders for it will fail-fast in runOne above.
      await writeFile(out, Buffer.alloc(0)).catch(() => {});
      await unlink(out).catch(() => {});
    }
  }
  return samples;
}

/** Run the descriptor's input args against a real bitstream, drop the
 *  decoded frame straight to a null muxer. Exit 0 ⇒ both the device
 *  init (when applicable) and the codec decode worked. */
async function probeOne(
  d: DecoderDescriptor,
  samplePath: string,
): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...d.buildInputArgs(),
    '-i',
    samplePath,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ];
  try {
    await execFileAsync('ffmpeg', args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
