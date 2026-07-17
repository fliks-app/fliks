import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { EncoderDescriptor } from './types';
import type { HwAccelType } from '../types';
import { qsvDeviceInitArgs, vaapiDeviceInitArgs } from '../hw-device';

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

/** The encoder hwAccels worth probing on a host whose detected accel is
 *  `detected`. The orchestrator only ever asks the registry for the detected
 *  accel, the CPU fallback (`'none'`), and — on a QSV host — VAAPI, because a
 *  cropped QSV encode falls back to the vaapi chain (see `requestedHwAccelFor`).
 *  Every other accel's encoders are never requested here, so probing them just
 *  spawns ffmpeg encodes guaranteed to fail (wrong device / encoder absent). */
export function probeableAccels(detected: HwAccelType): Set<HwAccelType> {
  switch (detected) {
    case 'qsv':
      return new Set(['qsv', 'vaapi', 'none']);
    case 'vaapi':
      return new Set(['vaapi', 'none']);
    case 'amf':
      return new Set(['amf', 'none']);
    case 'nvenc':
      return new Set(['nvenc', 'none']);
    case 'videotoolbox':
      return new Set(['videotoolbox', 'none']);
    default:
      return new Set(['none']);
  }
}

/** Probe one tiny ffmpeg per descriptor. HW-accel descriptors run
 *  serially within their family because driver state on the iGPU /
 *  dGPU is shared — 20+ concurrent VAAPI contexts trip 'internal
 *  encoding error 24' even when each context, taken alone, encodes
 *  cleanly. CPU descriptors run in parallel (no shared state).
 *  Probe args are derived from each descriptor's `buildArgs()` so we
 *  exercise the exact encoder + pixel format + filter the runtime
 *  path uses (modulo the lavfi source and the `-f null -` sink). */
export async function runEncoderProbes(
  descriptors: readonly EncoderDescriptor[],
  log: Logger,
  detectedHwAccel: HwAccelType,
): Promise<void> {
  const t0 = Date.now();
  const probeable = probeableAccels(detectedHwAccel);

  const cpuDescriptors: EncoderDescriptor[] = [];
  const hwDescriptors: EncoderDescriptor[] = [];
  const skipped: string[] = [];
  for (const d of descriptors) {
    if (!probeable.has(d.hwAccel)) {
      // The orchestrator never asks the registry for this hwAccel on this host
      // (see requestedHwAccelFor), so a probe here would only spawn a doomed
      // ffmpeg encode. Mark it disabled and skip — resolve() then falls through
      // to a usable encoder exactly as it would after a real probe failure.
      probeResult.set(d.id, false);
      skipped.push(d.id);
      continue;
    }
    (d.hwAccel === 'none' ? cpuDescriptors : hwDescriptors).push(d);
  }

  const runOne = async (
    d: EncoderDescriptor,
  ): Promise<{ id: string; ok: boolean }> => {
    if (!d.supports()) {
      probeResult.set(d.id, false);
      return { id: d.id, ok: false };
    }
    const ok = await probeOne(d, log);
    probeResult.set(d.id, ok);
    return { id: d.id, ok };
  };

  // CPU probes in parallel (no shared state). Every HW probe runs
  // strictly serially after the previous one finishes — QSV and VAAPI
  // are nominally different `hwAccel`s but on Linux Intel they share
  // a single iGPU device, and running them in parallel families still
  // produced the 'internal encoding error 24' false negatives we were
  // chasing.
  const cpuTask = Promise.all(cpuDescriptors.map(runOne));

  const hwTask = (async () => {
    const out: { id: string; ok: boolean }[] = [];
    for (const d of hwDescriptors) out.push(await runOne(d));
    return out;
  })();

  const settled = (await Promise.all([cpuTask, hwTask])).flat();

  probedOnce = true;
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const r of settled) {
    (r.ok ? enabled : disabled).push(r.id);
  }
  const probedCount = cpuDescriptors.length + hwDescriptors.length;
  log.log(
    `[encoder-probe] ${enabled.length}/${probedCount} enabled (${Date.now() - t0}ms): ${enabled.join(',')}${disabled.length ? ` | disabled: ${disabled.join(',')}` : ''}${skipped.length ? ` | skipped ${skipped.length} (accel != ${detectedHwAccel}): ${skipped.join(',')}` : ''}`,
  );
}

async function probeOne(d: EncoderDescriptor, _log: Logger): Promise<boolean> {
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
  // HW encoders only accept HW surfaces. Feed them through the same
  // device-init chain the runtime path uses so the probe exercises a
  // representative pipeline:
  //
  //  - VAAPI: `-init_hw_device vaapi=va ... -vf format=NV12,hwupload`.
  //    Format step matters — `yuv420p,hwupload` produces a VAAPI
  //    surface whose internal layout h264_vaapi rejects with
  //    'internal encoding error 24' at 320x180 specifically (probe
  //    false-negative we hit). nv12 / p010le sidestep the small-frame
  //    layout quirk.
  //  - QSV: the platform device chain from `hw-device.ts` (native
  //    `qsv=qs` on Windows, `vaapi=va` + `qsv=qs@va` on Linux), then
  //    `hwupload,format=qsv`. Feeding qsv surfaces (not raw lavfi CPU
  //    input relying on ffmpeg's auto-converter) keeps the probe honest
  //    on builds without that converter. No `extra_hw_frames`: a padded
  //    upload pool becomes a larger D3D11 array texture that the Intel
  //    D3D11 stack rejects with E_INVALIDARG, so the plain upload is
  //    both representative and the allocation that actually succeeds.
  //  - CPU (`'none'`): plain lavfi input — no device.
  const surfaceFmt = d.variant.bitDepth === 10 ? 'p010le' : 'nv12';
  const lavfi = `nullsrc=size=320x180:rate=30,format=${pixFmt}`;
  let inputArgs: string[];
  let filterArgs: string[];
  switch (d.hwAccel) {
    case 'vaapi':
      inputArgs = [
        ...vaapiDeviceInitArgs(),
        '-filter_hw_device',
        'va',
        '-f',
        'lavfi',
        '-i',
        lavfi,
      ];
      filterArgs = ['-vf', `format=${surfaceFmt},hwupload`];
      break;
    case 'qsv':
      inputArgs = [
        ...qsvDeviceInitArgs(),
        '-filter_hw_device',
        'qs',
        '-f',
        'lavfi',
        '-i',
        lavfi,
      ];
      filterArgs = ['-vf', `format=${surfaceFmt},hwupload,format=qsv`];
      break;
    default:
      inputArgs = ['-f', 'lavfi', '-i', lavfi];
      filterArgs = [];
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputArgs,
    '-frames:v',
    '1',
    ...filterArgs,
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
  } catch {
    // The disabled list in the summary log already names every failed
    // descriptor; suppressing the per-failure WARN here keeps boot
    // logs quiet on hosts where most HW paths aren't present (e.g.
    // a QSV-only deployment legitimately fails 18+ probes).
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
    case 'amf':
      if (d.variant.codec === 'av1') return 'av1_amf';
      if (d.variant.codec === 'hevc') return 'hevc_amf';
      return 'h264_amf';
    case 'videotoolbox':
      if (d.variant.codec === 'hevc') return 'hevc_videotoolbox';
      return 'h264_videotoolbox';
    case 'none':
      if (d.variant.codec === 'av1') return 'libsvtav1';
      if (d.variant.codec === 'hevc') return 'libx265';
      return 'libx264';
  }
}
