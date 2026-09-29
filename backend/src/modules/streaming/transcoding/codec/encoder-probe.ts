import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { EncoderDescriptor, EncoderInput, EncoderTarget } from './types';
import type { HwAccelType } from '../types';
import type { SurfaceFormat } from './decoders/types';
import {
  qsvDeviceInitArgs,
  vaapiDeviceInitArgs,
  vaapiRenderNode,
} from '../hw-device';
import { ffmpegTail } from './probe-utils';

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

/** True when the last boot probe found Intel's iHD VAAPI driver. Keyed to
 *  the render node it ran on, so a later admin re-pin invalidates it. */
let vaapiIsIntelIhd = false;
let vaapiIhdCheckedNode: string | null = null;

export function vaapiWritesHdrMetadata(): boolean {
  return vaapiIsIntelIhd && vaapiIhdCheckedNode === vaapiRenderNode();
}

/** ffmpeg logs the VAAPI driver's vendor string at verbose level during
 *  device init, so this needs no `vainfo` dependency and no real encode. */
async function detectVaapiIntelDriver(log: Logger): Promise<boolean> {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'verbose',
        ...vaapiDeviceInitArgs(),
        '-f',
        'lavfi',
        '-i',
        'nullsrc=size=64x64:rate=1',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { timeout: 10_000 },
    );
    return /VAAPI driver:\s*Intel iHD/i.test(stderr);
  } catch (err) {
    log.log(`[encoder-probe] VAAPI driver detection failed: ${ffmpegTail(err)}`);
    return false;
  }
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
 *  Probe args are the descriptor's own `buildArgs()`, with its `-vf` swapped
 *  for the probe's surface-upload filter, so a bad option fails at boot. */
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

  // Only the VAAPI HDR10 descriptors read this; skip the extra spawn otherwise.
  if (hwDescriptors.some((d) => d.hwAccel === 'vaapi' && d.variant.hdr === 'HDR10')) {
    vaapiIhdCheckedNode = vaapiRenderNode();
    vaapiIsIntelIhd = await detectVaapiIntelDriver(log);
    log.log(
      `[encoder-probe] vaapiWritesHdrMetadata=${vaapiIsIntelIhd} (node=${vaapiIhdCheckedNode})`,
    );
  }

  const runOne = async (
    d: EncoderDescriptor,
  ): Promise<{ id: string; ok: boolean }> => {
    if (!d.supports()) {
      probeResult.set(d.id, false);
      return { id: d.id, ok: false };
    }
    const ok = await probeOne(d);
    probeResult.set(d.id, ok);
    return { id: d.id, ok };
  };

  // CPU probes in parallel (no shared state). Every HW probe runs strictly
  // serially — QSV and VAAPI are nominally different `hwAccel`s but share a
  // single iGPU device on Linux Intel, and concurrent contexts there produce
  // 'internal encoding error 24' false negatives.
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

/** Throwaway target/tuning numbers for `buildArgs()` at probe time; only the
 *  shape matters, not the value, since the probe just needs valid args. */
const PROBE_TARGET: EncoderTarget = {
  width: 320,
  height: 180,
  videoBitrateBps: 1_000_000,
  gopSize: 48,
  frameRate: 24,
};
const PROBE_QSV_EXTRA = ['-forced_idr', '1', '-adaptive_i', '0', '-bf', '0', '-b_strategy', '0'];

function probeInputSurface(hwAccel: HwAccelType): SurfaceFormat {
  switch (hwAccel) {
    case 'qsv':
      return 'qsv';
    case 'vaapi':
      return 'vaapi';
    case 'nvenc':
      return 'cuda';
    default:
      return 'cpu';
  }
}

/** Minimal `EncoderInput` so a descriptor's real `buildArgs()` runs at boot
 *  instead of a hand-rolled stub. Exported for the structural build-args test. */
export function probeEncoderInput(d: EncoderDescriptor): EncoderInput {
  return {
    variant: d.variant,
    target: PROBE_TARGET,
    preset: 'veryfast',
    nvencPreset: 'p4',
    seekSeconds: 0,
    early: false,
    forceKeyframesExpr: 'expr:eq(n,0)',
    qsv: {
      extra: PROBE_QSV_EXTRA,
      rcInitOccupancy: PROBE_TARGET.videoBitrateBps,
      bufsize: PROBE_TARGET.videoBitrateBps,
    },
    libx264BufsizeMb: '2M',
    filters: {
      cropStr: '',
      cpuCropPrefix: '',
      hwCropPrefix: '',
      burnInFilter: '',
      tonemapVaapi: '',
      tonemapVulkan: '',
      tonemapOpencl: '',
      tonemapCuda: '',
      tonemapCpu: '',
    },
    tonemap: false,
    tonemapPath: 'vaapi',
    hasBurnIn: false,
    hasCrop: false,
    inputSurface: probeInputSurface(d.hwAccel),
  };
}

async function probeOne(d: EncoderDescriptor): Promise<boolean> {
  const pixFmt = d.variant.bitDepth === 10 ? 'yuv420p10le' : 'yuv420p';
  // HW encoders only accept HW surfaces. Feed them through the same
  // device-init chain the runtime path uses so the probe exercises a
  // representative pipeline:
  //
  //  - VAAPI: `-init_hw_device vaapi=va ... -vf format=NV12,hwupload`.
  //    Format step matters — `yuv420p,hwupload` produces a VAAPI surface
  //    whose internal layout h264_vaapi rejects with 'internal encoding
  //    error 24' at 320x180 specifically; nv12 / p010le sidestep it.
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

  // The descriptor's real args, minus its own `-vf` (the probe's surface-upload
  // filter above stands in for it).
  const encoderArgs = d.buildArgs(probeEncoderInput(d));
  const vfIdx = encoderArgs.indexOf('-vf');
  if (vfIdx !== -1) encoderArgs.splice(vfIdx, 2);

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputArgs,
    '-frames:v',
    '1',
    ...filterArgs,
    ...encoderArgs,
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
