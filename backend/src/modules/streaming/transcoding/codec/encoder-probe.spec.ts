import { probeableAccels, probeEncoderInput, vaapiWritesHdrMetadata } from './encoder-probe';
import { ALL_DESCRIPTORS } from './encoders';
import { av1QsvHdr10 } from './encoders/av1-qsv';
import { av1VaapiHdr10 } from './encoders/av1-vaapi';
import { hevcVaapiHdr10, hevcVaapiHlg } from './encoders/hevc-vaapi';

describe('probeableAccels', () => {
  it('always includes the CPU fallback so resolve() can degrade', () => {
    for (const a of ['qsv', 'vaapi', 'nvenc', 'videotoolbox', 'none'] as const) {
      expect(probeableAccels(a).has('none')).toBe(true);
    }
  });

  it('includes VAAPI on a QSV host (cropped QSV encodes fall back to vaapi)', () => {
    // requestedHwAccelFor maps qsv + crop -> vaapi, so vaapi encoders MUST stay
    // probeable on a QSV host or cropped transcodes lose their encoder.
    const qsv = probeableAccels('qsv');
    expect(qsv.has('qsv')).toBe(true);
    expect(qsv.has('vaapi')).toBe(true);
    expect(qsv.has('nvenc')).toBe(false);
    expect(qsv.has('videotoolbox')).toBe(false);
  });

  it('probes only its own accel + CPU for non-QSV hosts', () => {
    expect([...probeableAccels('vaapi')].sort()).toEqual(['none', 'vaapi']);
    expect([...probeableAccels('nvenc')].sort()).toEqual(['none', 'nvenc']);
    expect([...probeableAccels('videotoolbox')].sort()).toEqual([
      'none',
      'videotoolbox',
    ]);
    expect([...probeableAccels('none')]).toEqual(['none']);
  });
});

describe('vaapiWritesHdrMetadata', () => {
  it('defaults to false before the boot probe runs', () => {
    expect(vaapiWritesHdrMetadata()).toBe(false);
  });

  it('gates the VAAPI HDR10 descriptors, including the HLG sibling', () => {
    expect(av1VaapiHdr10.supportsHdrMetadata()).toBe(vaapiWritesHdrMetadata());
    expect(hevcVaapiHdr10.supportsHdrMetadata()).toBe(vaapiWritesHdrMetadata());
    expect(hevcVaapiHlg.supportsHdrMetadata()).toBe(vaapiWritesHdrMetadata());
  });
});

describe('av1_qsv_hdr10', () => {
  it('reports HDR metadata support (confirmed on Arc/iGPU, no driver gate needed)', () => {
    expect(av1QsvHdr10.supportsHdrMetadata()).toBe(true);
  });
});

describe('probeEncoderInput', () => {
  it('builds a real, valid argv for every registered descriptor', () => {
    for (const d of ALL_DESCRIPTORS) {
      const args = d.buildArgs(probeEncoderInput(d));
      expect(args).toContain('-c:v');
      // av1_qsv has no -mbbrc option on the bundled ffmpeg; a stale copy here
      // would fail at boot with the stricter, real-buildArgs probe.
      if (d.id === 'av1_qsv' || d.id === 'av1_qsv_hdr10') {
        expect(args).not.toContain('-mbbrc');
      }
    }
  });
});
