import { describe, expect, it } from 'vitest';
import { CastPlayerService } from './cast-player.service';

const sample = { engine: 'cast', stallCount: 1, bandwidthBps: 9 };
const qoeSample = (receivedAt: number | null, playbackId: string | null = null) =>
  CastPlayerService.prototype.qoeSample.call({
    playbackId,
    cast: { receiverQoe: () => (receivedAt === null ? null : { sample, receivedAt }) },
  } as never);

describe('CastPlayerService.qoeSample', () => {
  it('returns the receiver sample while it is fresh', () => {
    expect(qoeSample(Date.now())).toBe(sample);
  });

  it('stamps the playbackId of the viewing that was cast', () => {
    expect(qoeSample(Date.now(), 'pb-1')).toEqual({ ...sample, playbackId: 'pb-1' });
  });

  it('sends nothing while the receiver measured nothing', () => {
    const empty = { engine: 'cast', bandwidthBps: null };
    const call = (s: object) =>
      CastPlayerService.prototype.qoeSample.call({
        cast: { receiverQoe: () => ({ sample: s, receivedAt: Date.now() }) },
      } as never);
    expect(call(empty)).toBeNull();
  });

  it('drops a stale sample and an absent one', () => {
    expect(qoeSample(Date.now() - 60_000)).toBeNull();
    expect(qoeSample(null)).toBeNull();
  });
});
