import { HttpStatus } from '@nestjs/common';
import { SessionExpiredException } from './session-expired.exception';

describe('SessionExpiredException', () => {
  it('serialises to a 410 Gone with the stable error shape', () => {
    const ex = new SessionExpiredException('abc-123');
    expect(ex.getStatus()).toBe(HttpStatus.GONE);
    expect(ex.getResponse()).toEqual({
      code: 'session_expired',
      sid: 'abc-123',
      message: 'live session no longer exists',
    });
  });

  it('accepts a null sid (anonymous fetches)', () => {
    const ex = new SessionExpiredException(null);
    expect(ex.getStatus()).toBe(HttpStatus.GONE);
    expect((ex.getResponse() as { sid: unknown }).sid).toBeNull();
  });

  it('carries a custom reason when provided', () => {
    const ex = new SessionExpiredException('xyz', 'profileHash mismatch');
    const body = ex.getResponse() as { message: string };
    expect(body.message).toBe('profileHash mismatch');
  });
});
