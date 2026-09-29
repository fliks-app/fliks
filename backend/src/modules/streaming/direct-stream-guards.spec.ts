import type { StreamBuilderService } from './stream-builder.service';
import { makeStreamBuilder } from './stream-builder.test-helpers';
import type { DeviceProfileDto } from './dto/device-profile.dto';

const svc = () => makeStreamBuilder();

// mp4-only profile: the mkv source can't Direct Play (container mismatch) but its
// codecs are copyable, so DirectStream (remux) is the baseline absent a guard.
const profile = (extra: Partial<DeviceProfileDto> = {}): DeviceProfileDto =>
  ({
    directPlayProfiles: [
      { containers: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'] },
    ],
    maxAudioChannels: 6,
    ...extra,
  }) as never;

const resolved = () =>
  ({
    ext: '.mkv',
    absolutePath: '/media/file.mkv',
    contentType: 'video/x-matroska',
    mediaFile: {
      id: 1,
      streamInfo: {
        video: [
          { codec: 'h264', width: 1920, height: 1080, bitRate: 8_000_000, frameRate: '24' },
        ],
        audio: [{ codec: 'aac', channels: 2, bitRate: 128_000, streamIndex: 1, language: 'und' }],
        durationSeconds: 100,
      },
    },
  }) as never;

const flags = (r: ReturnType<StreamBuilderService['evaluate']>) =>
  r.response.transcodeReasons.map((x) => x.flag);

describe('StreamBuilderService - DirectStream guards', () => {
  it('remuxes by default (baseline)', () => {
    const r = svc().evaluate(resolved(), profile(), 'tok');
    expect(r.response.playMethod).toBe('DirectStream');
  });

  it('rejectCopy forces a transcode, flagged ClientRejectedCopy', () => {
    const r = svc().evaluate(resolved(), profile({ rejectCopy: true }), 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(flags(r)).toContain('ClientRejectedCopy');
  });

  it('a TS-mux session never gets DirectStream, flagged MuxNotSupported', () => {
    const r = svc().evaluate(resolved(), profile({ useTs: true }), 'tok');
    expect(r.response.playMethod).toBe('Transcode');
    expect(flags(r)).toContain('MuxNotSupported');
  });

  it('does not blame a gate that changed nothing, when burn-in already forces the transcode', () => {
    // Burn-in alone already makes the source uncopyable; useTs/rejectCopy
    // never get the chance to flip anything here.
    const r = svc().evaluate(
      resolved(),
      profile({ useTs: true, rejectCopy: true }),
      'tok',
      /* burnInSubtitleId */ 7,
    );
    expect(r.response.playMethod).toBe('Transcode');
    const f = flags(r);
    expect(f).toContain('SubtitleBurnIn');
    expect(f).not.toContain('MuxNotSupported');
    expect(f).not.toContain('ClientRejectedCopy');
  });

  it('rejectCopy also rules out DirectPlay, which serves the same video bitstream', () => {
    const r = svc().evaluate(
      resolved(),
      profile({
        rejectCopy: true,
        directPlayProfiles: [
          { containers: ['mkv'], videoCodecs: ['h264'], audioCodecs: ['aac'] },
        ],
      }),
      'tok',
    );
    expect(r.response.playMethod).toBe('Transcode');
    expect(r.response.transcodeReasons.map((x) => x.flag)).toContain('ClientRejectedCopy');
  });
});
