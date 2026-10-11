import { describe, expect, it, vi } from 'vitest';
import { CastPlayerService } from './cast-player.service';
import { decodeEdlWire, type EdlRange } from '../utils/edl-policy';

type Priv = {
  edlPayload(edl: EdlRange[] | undefined, base: Record<string, unknown>): { edl?: { v: 1; d: number[] } };
  getCastPlaybackInfo(mf: number, b?: number, a?: number, q?: string, s?: number): Promise<{ outputAudioCodec: string }>;
};

const make = (getPlaybackInfo: ReturnType<typeof vi.fn>) => {
  const svc = Object.create(CastPlayerService.prototype) as Record<string, unknown>;
  svc['translate'] = { instant: (k: string) => k };
  svc['streamingApi'] = { getPlaybackInfo, stopSession: vi.fn().mockResolvedValue(undefined) };
  svc['pcmForMutes'] = new Set<number>();
  svc['getCastDeviceProfile'] = () => ({
    directPlayProfiles: [{ audioCodecs: ['aac', 'ac3', 'eac3'] }],
  });
  return svc as unknown as Priv;
};

const mutes = (n: number): EdlRange[] =>
  Array.from({ length: n }, (_, i) => ({ start: i * 30 + 1.25, end: i * 30 + 3.5, action: 'mute' as const }));

describe('cast EDL payload', () => {
  it('encodes compactly and round-trips', () => {
    const p = make(vi.fn()).edlPayload(mutes(3), { title: 'x' });
    expect(decodeEdlWire(p.edl!)).toEqual(mutes(3));
  });
  it('fits a few thousand ranges in the budget', () => {
    expect(make(vi.fn()).edlPayload(mutes(3000), {}).edl).toBeDefined();
  });
  it('drops the EDL with a warning when over budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(make(vi.fn()).edlPayload(mutes(10000), {})).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('cast playback-info re-request', () => {
  const info = (outputAudioCodec: string) => ({
    outputAudioCodec,
    sessionId: 's',
    edl: [{ start: 1, end: 2, action: 'mute' }],
  });
  it('asks again without Dolby only when the output audio is Dolby', async () => {
    const aac = vi.fn().mockResolvedValue(info('aac'));
    await make(aac).getCastPlaybackInfo(1, undefined, undefined, undefined, 0);
    expect(aac).toHaveBeenCalledTimes(1);

    const ac3 = vi.fn().mockResolvedValue(info('ac3'));
    await make(ac3).getCastPlaybackInfo(1, undefined, undefined, undefined, 0);
    expect(ac3).toHaveBeenCalledTimes(2);
    expect(ac3.mock.calls[1][1].directPlayProfiles[0].audioCodecs).toEqual(['aac']);
  });
});
