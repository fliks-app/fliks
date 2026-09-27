import type { Request } from 'express';
import { SessionRouter } from './session-router.service';
import { SessionExpiredException } from '../session-expired.exception';
import { VARIANT_MAIN } from '../transcoding';

function req(sid?: string, userId?: number): Request {
  return {
    query: sid ? { sid } : {},
    user: userId != null ? { id: userId } : undefined,
  } as unknown as Request;
}

describe('SessionRouter', () => {
  let live: {
    get: jest.Mock;
    touch: jest.Mock;
    findCurrent: jest.Mock;
  };
  let transcoding: {
    getExistingSession: jest.Mock;
    findCurrentSession: jest.Mock;
    findCurrentEarlySession: jest.Mock;
  };
  let router: SessionRouter;

  beforeEach(() => {
    live = { get: jest.fn(), touch: jest.fn(), findCurrent: jest.fn() };
    transcoding = {
      getExistingSession: jest.fn(),
      findCurrentSession: jest.fn(),
      findCurrentEarlySession: jest.fn(),
    };
    router = new SessionRouter(live as never, transcoding as never);
  });

  describe('resolveSession', () => {
    it('routes to the exact session via the sid profileHash, main variant', () => {
      live.get.mockReturnValue({ profileHash: 'abc', kind: 'transcode' });
      transcoding.getExistingSession.mockReturnValue({ id: 's1' });
      expect(router.resolveSession(2, 7, req('SID'))).toEqual({ id: 's1' });
      expect(transcoding.getExistingSession).toHaveBeenCalledWith(2, 7, 'abc', VARIANT_MAIN);
      expect(transcoding.findCurrentSession).not.toHaveBeenCalled();
    });

    it('routes a remux live session through its own -remux[-aN][-u] variant, not the bare main hash', () => {
      live.get.mockReturnValue({
        profileHash: 'abc',
        kind: 'remux',
        audioStreamIndex: 2,
        remuxGrid: { boundaries: [0, 4] },
        useExtXMedia: false,
      });
      transcoding.getExistingSession.mockReturnValue({ id: 's-remux' });
      expect(router.resolveSession(2, 7, req('SID'))).toEqual({ id: 's-remux' });
      expect(transcoding.getExistingSession).toHaveBeenCalledWith(2, 7, 'abc', {
        kind: 'remux',
        audioIndex: 2,
        keyframeGrid: true,
      });
    });

    it('falls back to findCurrentSession with no sid', () => {
      transcoding.findCurrentSession.mockReturnValue({ id: 'cur' });
      expect(router.resolveSession(2, 7, req())).toEqual({ id: 'cur' });
    });

    it('does NOT fall back to another session\'s MRU when the sid is unknown / expired (a sibling instance may own it)', () => {
      live.get.mockReturnValue(undefined);
      transcoding.findCurrentSession.mockReturnValue({ id: 'cur' });
      expect(router.resolveSession(2, 7, req('STALE'))).toBeUndefined();
      expect(transcoding.findCurrentSession).not.toHaveBeenCalled();
    });
  });

  describe('assertFresh', () => {
    it('no-ops without a sid (direct-URL fetch)', () => {
      expect(() => router.assertFresh(req())).not.toThrow();
      expect(live.touch).not.toHaveBeenCalled();
    });

    it('throws SessionExpiredException when the sid is gone', () => {
      live.touch.mockReturnValue(false);
      expect(() => router.assertFresh(req('GONE'))).toThrow(
        SessionExpiredException,
      );
    });

    it('passes and warms the session when touch succeeds', () => {
      live.touch.mockReturnValue(true);
      expect(() => router.assertFresh(req('OK'))).not.toThrow();
      expect(live.touch).toHaveBeenCalledWith('OK');
    });
  });

  describe('findRequestSession', () => {
    it('returns the direct sid session', () => {
      live.get.mockReturnValue({ sessionId: 'x' });
      expect(router.findRequestSession(req('SID', 7), 2)).toEqual({
        sessionId: 'x',
      });
    });

    it('falls back to the user-current session', () => {
      live.get.mockReturnValue(undefined);
      live.findCurrent.mockReturnValue({ sessionId: 'y' });
      expect(router.findRequestSession(req(undefined, 7), 2)).toEqual({
        sessionId: 'y',
      });
      expect(live.findCurrent).toHaveBeenCalledWith(7, 2);
    });

    it('returns null with no sid and no user', () => {
      expect(router.findRequestSession(req(), 2)).toBeNull();
    });
  });
});
