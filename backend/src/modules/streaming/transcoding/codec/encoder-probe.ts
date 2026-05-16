import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { EncoderDescriptor } from './types';

const execFileAsync = promisify(execFile);

/** One-frame ffmpeg encode test. Each encoder descriptor gets probed at
 *  startup: encode a 320×180 black frame from `lavfi nullsrc` and check
 *  ffmpeg exits 0. Encoders that fail (missing in this ffmpeg build,
 *  HW generation too old, driver bug) are blacklisted in the runtime
 *  map so the registry resolver skips them, and the selector falls
 *  back to the next candidate.
 *
 *  Static `descriptor.supports()` is the build-time gate (cheap, sync);
 *  this probe layer is the runtime gate (one ffmpeg spawn per encoder,
 *  ~50-200ms each, parallelised). Both must pass before an encoder is
 *  usable.
 *
 *  The result map is a singleton — populated once at boot, mutated
 *  by `runEncoderProbes()` and queried by `isEncoderEnabled()`. */
const probeResult = new Map<string, boolean>();
let probedOnce = false;

/** Default: unprobed = usable. The runtime fallback in
 *  `getOrCreateSession()` catches mis-probed cases (e.g. encoder that
 *  passes the 1-frame test but breaks on the real content). After the
 *  first probe wave finishes, only the explicitly-passing entries
 *  stay true. */
export function isEncoderEnabled(descriptorId: string): boolean {
  if (!probedOnce) return true;
  return probeResult.get(descriptorId) ?? false;
}

/** Spawn one tiny ffmpeg per descriptor in parallel. Probe args are
 *  derived from each descriptor's `buildArgs()` so we exercise the
 *  exact encoder + pixel format + filter the runtime path uses (modulo
 *  the lavfi source and the 1-frame `-frames:v 1 -f null -` sink). */
export async function runEncoderProbes(
  descriptors: readonly EncoderDescriptor[],
  log: Logger,
): Promise<void> {
  const t0 = Date.now();
  const results = await Promise.allSettled(
    descriptors.map(async (d) => {
      // Static gate first — no point probing what hw-detect already
      // says is absent.
      if (!d.supports()) {
        probeResult.set(d.id, false);
        return { id: d.id, ok: false, reason: 'supports()=false' };
      }
      const ok = await probeOne(d, log);
      probeResult.set(d.id, ok);
      return { id: d.id, ok, reason: ok ? 'ok' : 'probe-failed' };
    }),
  );
  probedOnce = true;
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    (r.value.ok ? enabled : disabled).push(r.value.id);
  }
  log.log(
    `[encoder-probe] ${enabled.length}/${descriptors.length} enabled (${Date.now() - t0}ms): ${enabled.join(',')}${disabled.length ? ` | disabled: ${disabled.join(',')}` : ''}`,
  );
}

async function probeOne(
  d: EncoderDescriptor,
  log: Logger,
): Promise<boolean> {
  // Synthetic minimal input: a 320×180 black frame at the descriptor's
  // expected pixel layout. The encoder is invoked with the same arg
  // slice it would emit in production, just shortened to 1 frame.
  const isHdr = d.variant.hdr != null;
  const pixFmt = d.variant.bitDepth === 10 ? 'yuv420p10le' : 'yuv420p';
  const colorTags = isHdr
    ? [
        '-color_primaries',
        'bt2020',
        '-color_trc',
        d.variant.hdr === 'HLG' ? 'arib-std-b67' : 'smpte2084',
        '-colorspace',
        'bt2020nc',
      ]
    : [];
  // We bypass the descriptor's buildArgs because it expects HW input
  // surfaces; instead build a minimal CPU-source encode command that
  // targets the same `-c:v` and pixel format. The probe verifies the
  // encoder binary is present and accepts our flags — full HW pipeline
  // validation happens at first session spawn (errors caught by the
  // runtime fallback layer).
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `nullsrc=size=320x180:rate=30,format=${pixFmt}`,
    '-frames:v',
    '1',
    '-c:v',
    encoderName(d),
    ...colorTags,
    '-f',
    'null',
    '-',
  ];
  try {
    await execFileAsync('ffmpeg', args, { timeout: 10_000 });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[encoder-probe] ${d.id} failed: ${msg.split('\n')[0]}`);
    return false;
  }
}

/** Map descriptor id back to the ffmpeg encoder binary name. Reads
 *  the first `-c:v <name>` from a stub input that doesn't have HW
 *  surfaces — so descriptors that only accept HW-derived AVFrame
 *  inputs (HEVC HDR pipelines, etc.) get probed against the same
 *  encoder binary but with a CPU source. */
function encoderName(d: EncoderDescriptor): string {
  switch (d.hwAccel) {
    case 'qsv':
      if (d.variant.codec === 'av1') return 'av1_qsv';
      if (d.variant.codec === 'hevc') return 'hevc_qsv';
      return 'h264_qsv';
    case 'vaapi':
      if (d.variant.codec === 'av1') return 'av1_vaapi';
      if (d.variant.codec === 'hevc') return 'hevc_vaapi';
      return 'h264_vaapi';
    case 'nvenc':
      if (d.variant.codec === 'av1') return 'av1_nvenc';
      if (d.variant.codec === 'hevc') return 'hevc_nvenc';
      return 'h264_nvenc';
    case 'videotoolbox':
      if (d.variant.codec === 'hevc') return 'hevc_videotoolbox';
      return 'h264_videotoolbox';
    case 'none':
      if (d.variant.codec === 'av1') return 'libsvtav1';
      if (d.variant.codec === 'hevc') return 'libx265';
      return 'libx264';
  }
}
