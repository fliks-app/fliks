import { hevcNvenc, hevcNvencHdr10, hevcNvencHlg } from './hevc-nvenc';
import { h264Nvenc } from './h264-nvenc';
import { av1Nvenc, av1NvencHdr10, av1NvencHlg } from './av1-nvenc';
import { buildVideoFilters } from '../../ffmpeg-filter-graph';
import type { EncoderDescriptor, EncoderInput } from '../types';
import type { SurfaceFormat } from '../decoders/types';

/**
 * The NVENC descriptors must emit a filter graph valid for the surface the
 * decoder actually produced. NVENC encode and NVDEC decode are probed
 * independently, so an NVENC encoder can be paired with:
 *  - `cuda`  — NVDEC frames on the GPU (the happy path),
 *  - `cpu`   — software decode when NVDEC is disabled or can't decode the
 *              source codec/bit depth,
 *  - `vaapi` — a decode-only VAAPI stack bridged in on an NVENC host.
 * `scale_cuda` / `hwdownload` / `hwupload_cuda` require CUDA surfaces; run
 * on anything else they abort the graph with `Function not implemented`.
 */

const CROP = { width: 3840, height: 1632, x: 0, y: 264 };

function makeInput(cfg: {
  inputSurface: SurfaceFormat;
  tonemap?: boolean;
  crop?: boolean;
  sourceBitDepth?: number;
}): EncoderInput {
  const tonemap = cfg.tonemap ?? false;
  const crop = cfg.crop ? CROP : undefined;
  return {
    variant: { codec: 'hevc', bitDepth: 8, hdr: null },
    target: {
      width: 1920,
      height: 1080,
      videoBitrateBps: 8_000_000,
      gopSize: 72,
      frameRate: 24,
    },
    preset: 'fast',
    nvencPreset: 'p4',
    seekSeconds: 0,
    early: false,
    forceKeyframesExpr: 'expr:gte(t,0)',
    qsv: { extra: [], rcInitOccupancy: 0, bufsize: 0 },
    libx264BufsizeMb: '16M',
    filters: buildVideoFilters({
      crop,
      tonemap,
      useVaapiTonemap: false,
      sourceBitDepth: cfg.sourceBitDepth ?? (tonemap ? 10 : 8),
    }),
    tonemap,
    tonemapPath: 'opencl',
    hasBurnIn: false,
    hasCrop: !!crop,
    inputSurface: cfg.inputSurface,
  };
}

function vfOf(args: string[]): string {
  const i = args.indexOf('-vf');
  if (i === -1) throw new Error('no -vf in args');
  return args[i + 1];
}

function hasFlag(args: string[], flag: string, value: string): boolean {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] === value;
}

const SDR_ENCODERS: [string, EncoderDescriptor][] = [
  ['hevc_nvenc', hevcNvenc],
  ['h264_nvenc', h264Nvenc],
  ['av1_nvenc', av1Nvenc],
];

const HDR_ENCODERS: [string, EncoderDescriptor][] = [
  ['hevc_nvenc_main10', hevcNvencHdr10],
  ['hevc_nvenc_hlg', hevcNvencHlg],
  ['av1_nvenc_hdr10', av1NvencHdr10],
  ['av1_nvenc_hlg', av1NvencHlg],
];

const ALL_ENCODERS = [...SDR_ENCODERS, ...HDR_ENCODERS];

describe('NVENC encoders — surface-aware filter graph', () => {
  describe.each(SDR_ENCODERS)('%s (SDR)', (_id, enc) => {
    it('cuda decode + tonemap: hwdownload pulls GPU frames to CPU', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cuda', tonemap: true })));
      expect(vf).toContain('hwdownload,format=p010le,');
      // CPU tonemap must linearise + convert gamut, not just tone-curve.
      expect(vf).toContain('zscale=t=linear');
      expect(vf).toContain('tonemap=tonemap=hable');
      expect(vf).toContain('scale=1920:');
    });

    it('cpu decode + tonemap: no hwdownload, CPU tonemap chain only', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cpu', tonemap: true })));
      expect(vf).not.toContain('hwdownload');
      expect(vf).not.toContain('scale_cuda');
      expect(vf.startsWith('zscale=t=linear:npl=100,')).toBe(true);
      expect(vf).toContain('tonemap=tonemap=hable');
      expect(vf).toContain('scale=1920:');
    });

    it('vaapi decode + tonemap: hwdownload bridge before the CPU chain', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'vaapi', tonemap: true })));
      expect(vf.startsWith('hwdownload,format=p010le,')).toBe(true);
      expect(vf).not.toContain('scale_cuda');
      expect(vf).toContain('tonemap=tonemap=hable');
    });

    it('cuda decode, no tonemap: scale_cuda stays on the GPU as nv12', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cuda' })));
      expect(vf).toBe('scale_cuda=w=1920:h=-2:format=nv12');
    });

    it('cpu decode, no tonemap: software scale, no GPU filters', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cpu' })));
      expect(vf).toBe(
        'scale=1920:ceil(ih*1920/iw/2)*2:flags=lanczos,format=yuv420p',
      );
    });

    it('vaapi decode, no tonemap: hwdownload then CPU scale, no scale_cuda', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'vaapi' })));
      expect(vf).toBe(
        'hwdownload,format=nv12,scale=1920:ceil(ih*1920/iw/2)*2:flags=lanczos,format=yuv420p',
      );
    });

    it('cuda decode + crop: crop round-trips through hwupload_cuda', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cuda', crop: true })));
      expect(vf).toBe(
        'hwdownload,format=nv12,crop=3840:1632:0:264,hwupload_cuda,scale_cuda=w=1920:h=-2:format=nv12',
      );
    });

    it('cpu decode + crop: plain CPU crop, no hwupload_cuda', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cpu', crop: true })));
      expect(vf).toBe(
        'crop=3840:1632:0:264,scale=1920:ceil(ih*1920/iw/2)*2:flags=lanczos,format=yuv420p',
      );
    });
  });

  describe.each(HDR_ENCODERS)('%s (HDR)', (_id, enc) => {
    it('cuda decode: scale_cuda keeps pixels p010le on the GPU', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cuda', sourceBitDepth: 10 })));
      expect(vf).toBe('scale_cuda=w=1920:h=-2:format=p010le');
    });

    it('cuda decode + crop: p010le round-trip preserves 10-bit through crop', () => {
      const vf = vfOf(
        enc.buildArgs(makeInput({ inputSurface: 'cuda', crop: true, sourceBitDepth: 10 })),
      );
      expect(vf).toBe(
        'hwdownload,format=p010le,crop=3840:1632:0:264,hwupload_cuda,scale_cuda=w=1920:h=-2:format=p010le',
      );
    });

    it('cpu decode: software scale to p010le, no scale_cuda', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'cpu', sourceBitDepth: 10 })));
      expect(vf).toBe('scale=1920:ceil(ih*1920/iw/2)*2:flags=lanczos,format=p010le');
    });

    it('vaapi decode: hwdownload bridge to a CPU p010le scale', () => {
      const vf = vfOf(enc.buildArgs(makeInput({ inputSurface: 'vaapi', sourceBitDepth: 10 })));
      expect(vf).toBe(
        'hwdownload,format=p010le,scale=1920:ceil(ih*1920/iw/2)*2:flags=lanczos,format=p010le',
      );
    });
  });

  // Closed-GOP, deterministic-IDR flags: every NVENC descriptor must force
  // its keyframes to IDR and drop B-frame reordering, or HLS segments aren't
  // independently decodable (macroblock corruption — mirrors the qsvExtra
  // recipe). Independent of the input surface.
  describe.each(ALL_ENCODERS)('%s (GOP flags)', (id, enc) => {
    it('forces IDR keyframes and disables B-frames', () => {
      const args = enc.buildArgs(makeInput({ inputSurface: 'cuda', sourceBitDepth: 10 }));
      expect(hasFlag(args, '-forced-idr', '1')).toBe(true);
      expect(hasFlag(args, '-bf', '0')).toBe(true);
    });

    it('gates -no-scenecut on codec support (h264/hevc yes, av1 no)', () => {
      const args = enc.buildArgs(makeInput({ inputSurface: 'cuda', sourceBitDepth: 10 }));
      if (id.startsWith('av1')) {
        // av1_nvenc has no -no-scenecut option; passing it would abort the
        // encoder and drop it to the libsvtav1 fallback.
        expect(args).not.toContain('-no-scenecut');
      } else {
        expect(hasFlag(args, '-no-scenecut', '1')).toBe(true);
      }
    });
  });

  // Load-bearing invariant: only CUDA surfaces may drive `scale_cuda` /
  // `hwupload_cuda`. On any other surface those GPU-only filters must be
  // absent, and CPU-decoded input must carry no `hwdownload` at all.
  it.each(ALL_ENCODERS)('%s never runs CUDA filters on non-cuda input', (_id, enc) => {
    for (const tonemap of [false, true]) {
      for (const crop of [false, true]) {
        for (const surface of ['cpu', 'vaapi'] as SurfaceFormat[]) {
          const vf = vfOf(
            enc.buildArgs(makeInput({ inputSurface: surface, tonemap, crop, sourceBitDepth: 10 })),
          );
          expect(vf).not.toContain('scale_cuda');
          expect(vf).not.toContain('hwupload_cuda');
          if (surface === 'cpu') expect(vf).not.toContain('hwdownload');
        }
      }
    }
  });
});
