import { NotFoundException } from '@nestjs/common';
import {
  EngineResolverService,
  type LiveResolveDto,
} from './engine-resolver.service';

function make(user: object | null = { id: 3 }) {
  const userRepo = { findOne: jest.fn(async () => user) };
  const liveSessions = { viewer: jest.fn(() => ({ channelId: 9 })) };
  const channels = { findPlayable: jest.fn(async () => ({})) };
  const service = new EngineResolverService(
    userRepo as never,
    liveSessions as never,
    channels as never,
  );
  return { service, userRepo, liveSessions, channels };
}

const dto = (over: Partial<LiveResolveDto> = {}): LiveResolveDto => ({
  mediaId: 'sid-1',
  userId: 3,
  purpose: 'live',
  ...over,
});
const DENIED = { allow: false, ttlS: 60 };

describe('EngineResolverService.resolveLive', () => {
  it('allows a live viewer after the channel check, re-checked on every request', async () => {
    const { service, userRepo, channels, liveSessions } = make();
    await expect(service.resolveLive(dto())).resolves.toEqual({
      allow: true,
      ownerId: '3',
      ttlS: 0,
    });
    expect(userRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3, enabled: true } }),
    );
    expect(liveSessions.viewer).toHaveBeenCalledWith('sid-1');
    expect(channels.findPlayable).toHaveBeenCalledWith(9, { id: 3 });
  });

  it('denies a disabled or unknown user without looking at the viewer', async () => {
    const m = make(null);
    await expect(m.service.resolveLive(dto())).resolves.toEqual(DENIED);
    expect(m.liveSessions.viewer).not.toHaveBeenCalled();
  });

  it('denies an unknown viewer', async () => {
    const m = make();
    m.liveSessions.viewer.mockReturnValue(undefined as never);
    await expect(m.service.resolveLive(dto())).resolves.toEqual(DENIED);
    expect(m.channels.findPlayable).not.toHaveBeenCalled();
  });

  it('denies when the channel is no longer playable for the user', async () => {
    const m = make();
    m.channels.findPlayable.mockRejectedValue(new NotFoundException());
    await expect(m.service.resolveLive(dto())).resolves.toEqual(DENIED);
  });

  it('lets a host fault surface instead of caching a denial', async () => {
    const m = make();
    m.channels.findPlayable.mockRejectedValue(new Error('db down'));
    await expect(m.service.resolveLive(dto())).rejects.toThrow('db down');
  });
});
