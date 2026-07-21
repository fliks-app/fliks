import {
  errorSignature,
  formatErrorDiagnostics,
  isUndecodableError,
  userMessageKeyFor,
  type PlaybackError,
} from './playback-error';

describe('playback-error', () => {
  describe('userMessageKeyFor', () => {
    it('maps HTMLMediaElement error codes', () => {
      expect(userMessageKeyFor({ source: 'media', code: 1 })).toBe('player.error_aborted');
      expect(userMessageKeyFor({ source: 'media', code: 2 })).toBe('player.error_network');
      expect(userMessageKeyFor({ source: 'media', code: 3 })).toBe('player.error_decode');
      expect(userMessageKeyFor({ source: 'media', code: 4 })).toBe('player.error_unsupported');
    });

    it('maps Shaka network/decode/unsupported', () => {
      expect(userMessageKeyFor({ source: 'shaka', category: 1, code: 1002 })).toBe('player.error_network');
      expect(userMessageKeyFor({ source: 'shaka', category: 3, code: 3016 })).toBe('player.error_decode');
      expect(userMessageKeyFor({ source: 'shaka', category: 4, code: 4032 })).toBe('player.error_unsupported');
    });

    it('falls back to the generic key', () => {
      expect(userMessageKeyFor({ source: 'shaka', category: 3, code: 3017 })).toBe('player.playback_error');
      expect(userMessageKeyFor({ source: 'session' })).toBe('player.playback_error');
    });

    it('surfaces an explicit Dolby Vision message on a DV decode failure', () => {
      expect(userMessageKeyFor({ source: 'media', code: 3, dolbyVision: true })).toBe('player.dolby_vision_decode_failed');
      expect(userMessageKeyFor({ source: 'shaka', category: 3, code: 3016, dolbyVision: true })).toBe('player.dolby_vision_decode_failed');
      expect(userMessageKeyFor({ source: 'engine', dolbyVision: true })).toBe('player.dolby_vision_decode_failed');
    });

    it('does not blame Dolby Vision for a network/abort blip', () => {
      expect(userMessageKeyFor({ source: 'media', code: 2, dolbyVision: true })).toBe('player.error_network');
      expect(userMessageKeyFor({ source: 'media', code: 1, dolbyVision: true })).toBe('player.error_aborted');
      expect(userMessageKeyFor({ source: 'shaka', category: 1, code: 1002, dolbyVision: true })).toBe('player.error_network');
    });
  });

  describe('isUndecodableError', () => {
    it('flags media decode / unsupported', () => {
      expect(isUndecodableError({ source: 'media', code: 3 })).toBe(true);
      expect(isUndecodableError({ source: 'media', code: 4 })).toBe(true);
    });

    it('flags Shaka VIDEO_ERROR / CONTENT_UNSUPPORTED', () => {
      expect(isUndecodableError({ source: 'shaka', code: 3016 })).toBe(true);
      expect(isUndecodableError({ source: 'shaka', code: 4032 })).toBe(true);
    });

    it('keeps network / timeout / quota / session recoverable', () => {
      expect(isUndecodableError({ source: 'media', code: 1 })).toBe(false);
      expect(isUndecodableError({ source: 'media', code: 2 })).toBe(false);
      expect(isUndecodableError({ source: 'shaka', code: 1002 })).toBe(false);
      expect(isUndecodableError({ source: 'shaka', code: 3017 })).toBe(false);
      expect(isUndecodableError({ source: 'session' })).toBe(false);
    });
  });

  describe('errorSignature', () => {
    it('is stable for the same class and differs across classes', () => {
      const a: PlaybackError = { userMessage: '', source: 'shaka', category: 3, code: 3016 };
      const b: PlaybackError = { userMessage: 'x', source: 'shaka', category: 3, code: 3016, variant: 'hvc1' };
      const c: PlaybackError = { userMessage: '', source: 'media', code: 3 };
      expect(errorSignature(a)).toBe(errorSignature(b));
      expect(errorSignature(a)).not.toBe(errorSignature(c));
    });
  });

  describe('formatErrorDiagnostics', () => {
    it('renders code/category names, variant, context and data', () => {
      const err: PlaybackError = {
        userMessage: 'x',
        source: 'shaka',
        code: 3016,
        category: 3,
        severity: 2,
        variant: 'hvc1.1.6.L120 1920×1080 @3.0Mb/s',
        data: ['https://seg-500.m4s'],
        message: 'raw',
      };
      const out = formatErrorDiagnostics(err, { currentTime: 3012.4, mode: 'transcode', hwAccel: 'qsv' });
      expect(out).toContain('code: 3016 (VIDEO_ERROR)');
      expect(out).toContain('category: 3 (MEDIA)');
      expect(out).toContain('severity: 2 (CRITICAL)');
      expect(out).toContain('variant: hvc1.1.6.L120');
      expect(out).toContain('playMethod: transcode');
      expect(out).toContain('hwAccel: qsv');
      expect(out).toContain('position: 3012.4s');
      expect(out).toContain('seg-500.m4s');
    });

    it('maps MediaError code names', () => {
      const err: PlaybackError = { userMessage: 'x', source: 'media', code: 3 };
      expect(formatErrorDiagnostics(err, {})).toContain('code: 3 (MEDIA_ERR_DECODE)');
    });

    it('renders the engine, endpoint, title, device and app version', () => {
      const err: PlaybackError = { userMessage: 'x', source: 'engine', code: -1, message: 'loading failed' };
      const out = formatErrorDiagnostics(err, {
        engine: 'desktop-mpv',
        url: '/api/stream/3?token=abc&sid=xyz',
        title: 'Some Series — S1:E2 - An Episode',
        device: 'desktop/electron · UA',
        appVersion: '1.15.2',
      });
      expect(out).toContain('engine: desktop-mpv');
      expect(out).toContain('url: /api/stream/3?token=abc&sid=xyz');
      expect(out).toContain('title: Some Series — S1:E2 - An Episode');
      expect(out).toContain('device: desktop/electron · UA');
      expect(out).toContain('appVersion: 1.15.2');
      expect(out).toContain('message: loading failed');
    });
  });
});
