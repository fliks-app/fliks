import { describe, expect, it, vi } from 'vitest';
import { CastPlayerService } from './cast-player.service';

const sample = { engine: 'cast', stallCount: 1, recoveryReloads: 0, bandwidthBps: 9 };
const qoeSample = (receivedAt: number | null, playbackId: string | null = null, recoveries = 0, s: object = sample) =>
  CastPlayerService.prototype.qoeSample.call({
    playbackId,
    recoveries,
    cast: { receiverQoe: () => (receivedAt === null ? null : { sample: s, receivedAt }) },
  } as never);

describe('CastPlayerService.qoeSample', () => {
  it('returns the receiver sample while it is fresh', () => {
    expect(qoeSample(Date.now())).toMatchObject(sample);
  });

  it('stamps the playbackId of the viewing that was cast', () => {
    expect(qoeSample(Date.now(), 'pb-1')).toMatchObject({ ...sample, playbackId: 'pb-1' });
  });

  it('keeps the id the receiver echoed and adds the sender-side recoveries', () => {
    expect(qoeSample(Date.now(), 'pb-1', 1, { ...sample, playbackId: 'rx' })).toMatchObject({
      playbackId: 'rx',
      recoveryReloads: 1,
    });
  });

  it('does not forward the stall episodes in the heartbeat', () => {
    const s = { ...sample, stalls: [{ at: 1, durationMs: 2 }] };
    expect(qoeSample(Date.now(), null, 0, s)).not.toHaveProperty('stalls');
  });

  it('sends nothing while the receiver measured nothing', () => {
    expect(qoeSample(Date.now(), null, 0, { engine: 'cast', recoveryReloads: 0, bandwidthBps: null })).toBeNull();
  });

  it('drops a stale sample and an absent one', () => {
    expect(qoeSample(Date.now() - 60_000)).toBeNull();
    expect(qoeSample(null)).toBeNull();
  });
});

describe('CastPlayerService.recordReceiverStalls', () => {
  const ep = { at: 1000, position: 12, durationMs: 2000, bufferAheadS: 0.2, bandwidthBps: 5 };

  it('turns each episode into one stall event, even when the message repeats', () => {
    const record = vi.fn();
    const self = { liveSessionId: () => 's', seenStalls: new Set<number>(), qoeReporter: { record }, playbackId: 'pb' };
    const call = (s: object) => (CastPlayerService.prototype as any).recordReceiverStalls.call(self, s);
    call({ stalls: [ep] });
    call({ stalls: [ep, { ...ep, at: 9000 }] });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(
      's',
      { type: 'stall', at: 3000, position: 12, durationMs: 2000, bufferAheadS: 0.2, bandwidthBps: 5 },
      false,
      'pb',
    );
  });
});
