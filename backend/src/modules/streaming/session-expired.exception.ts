import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 410 Gone for HLS requests that carry a `sid` query the
 * LiveSessionRegistry no longer knows. Surfaces a deterministic signal
 * the client can react to (refetch `/playback-info`, reload the engine)
 * instead of the indefinite 5xx retry storm that follows a generic
 * `Error` thrown deep in the transcode setup path.
 *
 * The body shape is stable across players:
 *   { code: 'session_expired', sid, message }
 *
 * Shaka response filter and the Tizen / Capacitor / webOS native engine
 * wrappers all match on `code === 'session_expired'` to trigger the
 * shared {@link refreshSidAndReload} recovery flow.
 */
export class SessionExpiredException extends HttpException {
  constructor(sid: string | null, reason = 'live session no longer exists') {
    super(
      { code: 'session_expired', sid, message: reason },
      HttpStatus.GONE,
    );
  }
}
