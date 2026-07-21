/**
 * Structured playback error surfaced on the player's error card.
 *
 * The engine `error` event carries raw fields (a Shaka `shaka.util.Error`,
 * an HTMLMediaElement `MediaError`, or an app/session error); the state
 * service composes them into this shape so the overlay can show a
 * translated line PLUS a copyable technical block (code, category,
 * severity, the failing variant, and any Shaka `data[]` payload — which is
 * where Shaka puts the failing segment URL, the nested MediaError, etc.).
 */
export interface PlaybackError {
  /** Translated, human-facing one-liner shown under the title. */
  userMessage: string;
  /** Which layer reported it — drives the diagnostics header. */
  source: 'shaka' | 'media' | 'session' | 'engine';
  /** Numeric error code: Shaka `error.code`, or `MediaError.code` (1-4). */
  code?: number;
  /** Shaka error category (1 NETWORK, 3 MEDIA, 4 MANIFEST, …). */
  category?: number;
  /** Shaka severity (1 RECOVERABLE, 2 CRITICAL). */
  severity?: number;
  /** Shaka `error.data[]` — extra args (failing URL, nested error, …). */
  data?: unknown[];
  /** Active variant at failure, e.g. `hvc1.1.6.L120 1920×1080 @3.0Mb/s`. */
  variant?: string;
  /** Raw engine/console message (untranslated). */
  message?: string;
}

/** shaka.util.Error.Category — the ones a playback failure can carry. */
const SHAKA_CATEGORY_NAMES: Record<number, string> = {
  1: 'NETWORK',
  2: 'TEXT',
  3: 'MEDIA',
  4: 'MANIFEST',
  5: 'STREAMING',
  6: 'DRM',
  7: 'PLAYER',
  8: 'CAST',
  9: 'STORAGE',
  10: 'ADS',
};

/** shaka.util.Error.Code — the subset that shows up on playback failures.
 *  Unknown codes fall back to the bare number, so this never needs to be
 *  exhaustive to stay useful. */
const SHAKA_CODE_NAMES: Record<number, string> = {
  1001: 'BAD_HTTP_STATUS',
  1002: 'HTTP_ERROR',
  1003: 'TIMEOUT',
  1006: 'REQUEST_FILTER_ERROR',
  3014: 'MEDIA_SOURCE_OPERATION_FAILED',
  3015: 'MEDIA_SOURCE_OPERATION_THREW',
  3016: 'VIDEO_ERROR',
  3017: 'QUOTA_EXCEEDED_ERROR',
  3018: 'TRANSMUXING_FAILED',
  3019: 'CONTENT_TRANSFORMATION_FAILED',
  4000: 'UNABLE_TO_GUESS_MANIFEST_TYPE',
  4032: 'CONTENT_UNSUPPORTED_BY_BROWSER',
  4038: 'HLS_INTERNAL_ERROR',
  7000: 'LOAD_INTERRUPTED',
  7002: 'OBJECT_DESTROYED',
};

/** HTMLMediaElement `MediaError.code`. */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

/** i18n key for the human line, mapped from the error class. Falls back to
 *  the generic `player.playback_error`. */
export function userMessageKeyFor(err: {
  source: PlaybackError['source'];
  code?: number;
  category?: number;
  dolbyVision?: boolean;
}): string {
  // A fatal failure while presenting Dolby Vision untouched is almost always the
  // DV bitstream the device couldn't decode — show an explicit, actionable line.
  // Network / abort blips keep their own message.
  if (err.dolbyVision && !isNetworkOrAbort(err)) {
    return 'player.dolby_vision_decode_failed';
  }
  if (err.source === 'media') {
    switch (err.code) {
      case 1:
        return 'player.error_aborted';
      case 2:
        return 'player.error_network';
      case 3:
        return 'player.error_decode';
      case 4:
        return 'player.error_unsupported';
    }
  }
  if (err.source === 'shaka') {
    if (err.category === 1) return 'player.error_network';
    if (err.code === 3016) return 'player.error_decode';
    if (err.code === 4032) return 'player.error_unsupported';
  }
  return 'player.playback_error';
}

/** Transient transport failures (network / user abort) — distinct from a
 *  decode/format failure, so a Dolby Vision title doesn't blame DV for a
 *  dropped connection. */
export function isNetworkOrAbort(err: {
  source: PlaybackError['source'];
  code?: number;
  category?: number;
}): boolean {
  if (err.source === 'media') return err.code === 1 || err.code === 2;
  if (err.source === 'shaka') return err.category === 1;
  return false;
}

/** A stream-level decode/format failure that a fresh session cannot fix —
 *  the player must show it terminally instead of looping lost-session
 *  recovery. Kept conservative: network / session / timeout / quota stay
 *  recoverable. */
export function isUndecodableError(err: {
  source: PlaybackError['source'];
  code?: number;
}): boolean {
  if (err.source === 'media') return err.code === 3 || err.code === 4;
  if (err.source === 'shaka') return err.code === 3016 || err.code === 4032;
  return false;
}

/** A stable one-line signature so repeated identical failures can be
 *  detected (used to avoid resetting the recovery budget on a reload that
 *  reproduces the exact same error). */
export function errorSignature(err: PlaybackError): string {
  return `${err.source}:${err.category ?? ''}:${err.code ?? ''}`;
}

/** Multi-line technical dump for the error card's details block and the
 *  "copy diagnostics" button. Field labels are terse English tokens on
 *  purpose — this is a diagnostic artifact meant to be pasted into a bug
 *  report, not translated UI copy. */
export function formatErrorDiagnostics(
  err: PlaybackError,
  ctx: {
    currentTime?: number;
    mode?: string;
    hwAccel?: string;
    engine?: string;
    url?: string;
    title?: string;
    device?: string;
    appVersion?: string;
  },
): string {
  const codeName =
    err.source === 'media'
      ? MEDIA_ERROR_NAMES[err.code ?? -1]
      : SHAKA_CODE_NAMES[err.code ?? -1];
  const catName =
    err.category != null ? SHAKA_CATEGORY_NAMES[err.category] : undefined;
  const lines: string[] = [];
  if (ctx.title) lines.push(`title: ${ctx.title}`);
  if (ctx.device) lines.push(`device: ${ctx.device}`);
  if (ctx.appVersion) lines.push(`appVersion: ${ctx.appVersion}`);
  lines.push(`source: ${err.source}`);
  if (ctx.engine) lines.push(`engine: ${ctx.engine}`);
  if (err.code != null) lines.push(`code: ${err.code}${codeName ? ` (${codeName})` : ''}`);
  if (err.category != null) lines.push(`category: ${err.category}${catName ? ` (${catName})` : ''}`);
  if (err.severity != null) lines.push(`severity: ${err.severity}${err.severity === 2 ? ' (CRITICAL)' : err.severity === 1 ? ' (RECOVERABLE)' : ''}`);
  if (err.variant) lines.push(`variant: ${err.variant}`);
  if (ctx.mode) lines.push(`playMethod: ${ctx.mode}`);
  if (ctx.hwAccel) lines.push(`hwAccel: ${ctx.hwAccel}`);
  if (ctx.currentTime != null) lines.push(`position: ${ctx.currentTime.toFixed(1)}s`);
  if (ctx.url) lines.push(`url: ${ctx.url}`);
  if (err.message) lines.push(`message: ${err.message}`);
  if (err.data && err.data.length) {
    let dump: string;
    try {
      dump = JSON.stringify(err.data, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
    } catch {
      dump = String(err.data);
    }
    lines.push(`data: ${dump}`);
  }
  return lines.join('\n');
}
