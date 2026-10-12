import { describe, expect, it } from 'vitest';
import { CastPlayerService } from './cast-player.service';

const sample = { engine: 'cast', stallCount: 1 };
const qoeSample = (receivedAt: number | null) =>
  CastPlayerService.prototype.qoeSample.call({
    cast: { receiverQoe: () => (receivedAt === null ? null : { sample, receivedAt }) },
  } as never);

describe('CastPlayerService.qoeSample', () => {
  it('returns the receiver sample while it is fresh', () => {
    expect(qoeSample(Date.now())).toBe(sample);
  });

  it('drops a stale sample and an absent one', () => {
    expect(qoeSample(Date.now() - 60_000)).toBeNull();
    expect(qoeSample(null)).toBeNull();
  });
});
