/** Synthetic hosts for the hw-detect vectors: a model of what ffmpeg answers on each machine. */

export type Accel = 'qsv' | 'vaapi' | 'nvenc' | 'amf' | 'videotoolbox';

export interface DrmDevice {
  vendor: string | null;
  device: string | null;
  bootVga: string | null;
  realpath: string;
  drmEntries: string[];
}

export interface Env {
  platform: 'linux' | 'darwin' | 'win32';
  /** Setting applied after boot (a re-pin); `auto` means none. */
  gpuRenderNode: string;
  /** `/dev/dri` listing, null when the directory does not exist. */
  driEntries: string[] | null;
  drm: Record<string, DrmDevice>;
}

export interface Call {
  args: string[];
  timeoutMs: number;
  exit: number;
  stderr: string;
  stdout?: string;
}

export type PauseModel = 'pausable' | 'ignores-key' | 'spawn-fails';

export interface Machine {
  libfdk: boolean;
  /** Software encoders the ffmpeg build has. */
  sw: string[];
  /** Backends whose one-frame detect test passes. */
  accel: Accel[];
  /** Hardware encoders whose probe encode passes. */
  hwEncoders: string[];
  /** `-hwaccel` values whose decode probe passes. */
  hwDecoders: string[];
  ihd: boolean;
  filters: Partial<Record<Filter, boolean>>;
  /** Extra failures: returns the stderr to fail with, or undefined. */
  fail?: ((joined: string) => string | undefined)[];
}

export type Filter =
  | 'tonemapOpencl'
  | 'tonemapOpenclCrop'
  | 'tonemapOpenclHdr10'
  | 'qsvOpencl'
  | 'qsvOpenclHdr10'
  | 'vppQsv'
  | 'vulkan'
  | 'cuda'
  | 'cudaHdr10'
  | 'opencl'
  | 'openclHdr10'
  | 'amfOpencl';

export interface Scenario {
  name: string;
  note: string;
  env: Env;
  pause: PauseModel;
  /** Synthetic scenarios script ffmpeg with `machine`; recorded ones replay `calls`. */
  machine?: Machine;
}

const ENCODERS_HEAD = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
`;

function encodersList(m: Machine): string {
  const lines = [
    ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
    ' V....D libx265              libx265 H.265 / HEVC (codec hevc)',
    ' A....D aac                  AAC (Advanced Audio Coding)',
  ];
  if (m.libfdk)
    lines.push(
      ' A....D libfdk_aac           Fraunhofer FDK AAC (codec aac)',
      ' A....D libfdk_aac_extra     not the same word (codec aac)',
    );
  return ENCODERS_HEAD + lines.join('\n') + '\n';
}

const ok = (o: Partial<Call> = {}) => ({ exit: 0, stderr: '', ...o });
const fail = (stderr: string) => ({ exit: 1, stderr });

/** Answers one ffmpeg invocation the way `m` would. Throws on an argv it has no rule for. */
export function model(m: Machine) {
  return (
    args: string[],
  ): { exit: number; stderr: string; stdout?: string } => {
    const j = args.join(' ');
    if (args.includes('-encoders')) return ok({ stdout: encodersList(m) });
    for (const f of m.fail ?? []) {
      const r = f(j);
      if (r) return fail(r);
    }
    const flag = (n: string) =>
      args.includes(n) ? args[args.indexOf(n) + 1] : '';
    const enc = flag('-c:v');
    if (flag('-loglevel') === 'verbose') {
      if (!m.accel.includes('vaapi') && !m.accel.includes('qsv'))
        return fail(
          'Failed to initialise VAAPI connection: -1 (unknown libva error).',
        );
      const drv = m.ihd
        ? 'Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()'
        : 'Mesa Gallium driver 24.0.9 for AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6, DRM 3.57, 6.8.0)';
      return ok({
        stderr: `[AVHWDeviceContext @ 0x1] VAAPI driver: ${drv}.\n`,
      });
    }
    // Sample bitstreams for the decoder and tone-map probes.
    if (args.includes('-y') && /^lib(x264|x265|svtav1)$/.test(enc))
      return m.sw.includes(enc) ? ok() : fail(`Unknown encoder '${enc}'`);
    // hw-detect one-frame tests.
    if (j.includes('color=black')) {
      const accel = enc.replace(/^.*_/, '') as Accel;
      return m.accel.includes(accel)
        ? ok()
        : fail(
            `Device creation failed: -22.\nError initializing the ${accel} device`,
          );
    }
    // Tone-map probes, told apart by their filter graph.
    if (j.includes('tonemap_cuda'))
      return flt(m, j.includes('apply_dovi=1') ? 'cudaHdr10' : 'cuda');
    if (j.includes('scale_opencl')) return flt(m, 'amfOpencl');
    if (j.includes('opencl=ocl@dx'))
      return flt(
        m,
        j.includes('apply_dovi=1') ? 'qsvOpenclHdr10' : 'qsvOpencl',
      );
    if (j.includes('opencl=ocl:0.0')) {
      if (j.includes('apply_dovi=1')) return flt(m, 'tonemapOpenclHdr10');
      return flt(
        m,
        j.includes(',crop=') ? 'tonemapOpenclCrop' : 'tonemapOpencl',
      );
    }
    if (j.includes('hwupload,tonemap_opencl'))
      return flt(m, j.includes('apply_dovi=1') ? 'openclHdr10' : 'opencl');
    if (j.includes('vpp_qsv=tonemap=1')) return flt(m, 'vppQsv');
    if (j.includes('libplacebo')) return flt(m, 'vulkan');
    // Decoder probes read a sample; encoder probes read lavfi.
    if (j.includes('decoder-probe-')) {
      const hw = flag('-hwaccel');
      if (!hw) return ok();
      return m.hwDecoders.includes(hw)
        ? ok()
        : fail(`Device creation failed for ${hw}`);
    }
    if (enc) {
      if (m.sw.includes(enc) || m.hwEncoders.includes(enc)) return ok();
      return fail(`Unknown encoder '${enc}' or device not available`);
    }
    throw new Error(`hw model has no rule for: ffmpeg ${j}`);
  };
}

function flt(m: Machine, f: Filter) {
  return m.filters[f]
    ? ok()
    : fail(
        `Impossible to convert between the formats supported by the filter (${f})`,
      );
}

const ALL_SW = ['libx264', 'libx265', 'libsvtav1'];

const base: Machine = {
  libfdk: false,
  sw: ALL_SW,
  accel: [],
  hwEncoders: [],
  hwDecoders: [],
  ihd: false,
  filters: {},
};

/** The model above matches probes by encoder name, but descriptor ids differ (`hevc_qsv_main10`
 *  uses the `hevc_qsv` encoder), so a failing descriptor is injected by its distinguishing flags. */
const failArgs =
  (...needles: string[]) =>
  (j: string) =>
    needles.every((n) => j.includes(n))
      ? 'Error while opening encoder: Function not implemented'
      : undefined;

const intelEnv = (node: string): Env => ({
  platform: 'linux',
  gpuRenderNode: node,
  driEntries: ['by-path', 'card1', 'renderD128'],
  drm: {
    renderD128: {
      vendor: '0x8086',
      device: '0x9a49',
      bootVga: '1',
      realpath: '/sys/devices/pci0000:00/0000:00:02.0',
      drmEntries: ['card1', 'renderD128'],
    },
  },
});

export const SYNTHETIC: Scenario[] = [
  {
    name: 'linux-cpu-only',
    note: 'Linux host with no /dev/dri; every hardware test fails; ffmpeg ignores stdin p/u.',
    env: {
      platform: 'linux',
      gpuRenderNode: 'auto',
      driEntries: null,
      drm: {},
    },
    pause: 'ignores-key',
    machine: { ...base },
  },
  {
    name: 'linux-vaapi-amd',
    note: 'AMD iGPU through Mesa: QSV fails, VAAPI passes, no iHD, Vulkan tone-map only.',
    env: {
      platform: 'linux',
      gpuRenderNode: 'auto',
      driEntries: ['by-path', 'card0', 'renderD128'],
      drm: {
        renderD128: {
          vendor: '0x1002',
          device: '0x1638',
          bootVga: '1',
          realpath: '/sys/devices/pci0000:00/0000:00:08.1/0000:34:00.0',
          drmEntries: ['card0', 'renderD128'],
        },
      },
    },
    pause: 'pausable',
    machine: {
      ...base,
      accel: ['vaapi'],
      hwEncoders: ['h264_vaapi', 'hevc_vaapi', 'av1_vaapi'],
      hwDecoders: ['vaapi'],
      filters: { vulkan: true },
    },
  },
  {
    name: 'linux-qsv-intel-ihd',
    note: 'Intel iGPU, iHD driver: QSV passes, tone-map OpenCL, vpp_qsv and Vulkan work, libfdk present.',
    env: intelEnv('auto'),
    pause: 'pausable',
    machine: {
      ...base,
      libfdk: true,
      accel: ['qsv', 'vaapi'],
      ihd: true,
      hwEncoders: [
        ...['h264', 'hevc', 'av1'].flatMap((c) => [`${c}_qsv`, `${c}_vaapi`]),
      ],
      hwDecoders: ['vaapi'],
      filters: {
        tonemapOpencl: true,
        tonemapOpenclCrop: true,
        tonemapOpenclHdr10: true,
        vppQsv: true,
        vulkan: true,
      },
    },
  },
  {
    name: 'linux-qsv-partial',
    note: 'QSV passes but the HDR10/HLG HEVC and AV1 QSV encodes, the AV1 decode and the crop bridge fail (blacklisted ids).',
    env: intelEnv('auto'),
    pause: 'pausable',
    machine: {
      ...base,
      accel: ['qsv', 'vaapi'],
      ihd: true,
      hwEncoders: ['h264_qsv', 'hevc_qsv', 'h264_vaapi', 'hevc_vaapi'],
      hwDecoders: ['vaapi'],
      filters: {
        tonemapOpencl: true,
        tonemapOpenclCrop: false,
        tonemapOpenclHdr10: false,
      },
      fail: [
        failArgs('hevc_qsv', 'main10'),
        failArgs('decoder-probe-av1', '-hwaccel vaapi'),
        failArgs('hevc_vaapi', '-profile:v 2'),
      ],
    },
  },
  {
    name: 'linux-qsv-broken-vaapi-fallback',
    note: 'The QSV one-frame test fails but VAAPI passes: the backend falls back to VAAPI.',
    env: intelEnv('auto'),
    pause: 'pausable',
    machine: {
      ...base,
      accel: ['vaapi'],
      ihd: true,
      hwEncoders: ['h264_vaapi', 'hevc_vaapi', 'av1_vaapi'],
      hwDecoders: ['vaapi'],
      filters: {
        tonemapOpencl: true,
        tonemapOpenclCrop: true,
        tonemapOpenclHdr10: true,
        vulkan: true,
      },
    },
  },
  {
    name: 'linux-gpu-broken-cpu-fallback',
    note: 'A render node exists but every hardware test fails: the host falls back to CPU, GPUs are still listed.',
    env: intelEnv('auto'),
    pause: 'pausable',
    machine: { ...base },
  },
  {
    name: 'linux-nvenc',
    note: 'NVIDIA dGPU: QSV and VAAPI fail, NVENC passes, CUDA and OpenCL tone-map work.',
    env: {
      platform: 'linux',
      gpuRenderNode: 'auto',
      driEntries: ['by-path', 'card1', 'renderD128'],
      drm: {
        renderD128: {
          vendor: '0x10de',
          device: '0x2504',
          bootVga: '1',
          realpath: '/sys/devices/pci0000:00/0000:00:01.0/0000:01:00.0',
          drmEntries: ['card1', 'renderD128'],
        },
      },
    },
    pause: 'pausable',
    machine: {
      ...base,
      accel: ['nvenc'],
      hwEncoders: ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'],
      hwDecoders: ['cuda'],
      filters: {
        cuda: true,
        cudaHdr10: true,
        opencl: true,
        openclHdr10: false,
      },
    },
  },
  {
    name: 'win32-amf',
    note: 'Windows AMD: native QSV fails, AMF passes; D3D11 decode, OpenCL bridge works; ffmpeg has no stdin pause.',
    env: {
      platform: 'win32',
      gpuRenderNode: 'auto',
      driEntries: null,
      drm: {},
    },
    pause: 'ignores-key',
    machine: {
      ...base,
      accel: ['amf'],
      hwEncoders: ['h264_amf', 'hevc_amf', 'av1_amf'],
      hwDecoders: ['d3d11va'],
      filters: { amfOpencl: true, opencl: true, openclHdr10: true },
    },
  },
  {
    name: 'win32-qsv',
    note: 'Windows Intel: native QSV passes, D3D11 decode, OpenCL bridge for tone-map and vpp_qsv work.',
    env: {
      platform: 'win32',
      gpuRenderNode: 'auto',
      driEntries: null,
      drm: {},
    },
    pause: 'pausable',
    machine: {
      ...base,
      accel: ['qsv'],
      hwEncoders: ['h264_qsv', 'hevc_qsv', 'av1_qsv'],
      hwDecoders: ['d3d11va'],
      filters: { vppQsv: true, qsvOpencl: true, qsvOpenclHdr10: true },
    },
  },
  {
    name: 'darwin-videotoolbox',
    note: 'Apple Silicon: VideoToolbox passes (encode and decode), no GPU nodes, no libfdk.',
    env: {
      platform: 'darwin',
      gpuRenderNode: 'auto',
      driEntries: null,
      drm: {},
    },
    pause: 'pausable',
    machine: {
      ...base,
      accel: ['videotoolbox'],
      hwEncoders: ['h264_videotoolbox', 'hevc_videotoolbox'],
      hwDecoders: ['videotoolbox'],
      fail: [failArgs('-hwaccel videotoolbox', '-c:v av1')],
    },
  },
];
