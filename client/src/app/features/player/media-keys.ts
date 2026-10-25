export type MediaKeyAction = 'toggle' | 'play' | 'pause' | 'stop' | 'forward' | 'rewind';

const BY_KEY: Record<string, MediaKeyAction> = {
  MediaPlayPause: 'toggle',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaStop: 'stop',
  MediaFastForward: 'forward',
  MediaRewind: 'rewind',
  MediaTrackNext: 'forward',
  MediaTrackPrevious: 'rewind',
};

// Tizen and webOS remotes send these keyCodes with no reliable `key`.
const BY_KEYCODE: Record<number, MediaKeyAction> = {
  10252: 'toggle',
  415: 'play',
  19: 'pause',
  413: 'stop',
  417: 'forward',
  412: 'rewind',
};

/** Tizen's remote keys beyond the default set; they are only delivered once registered. */
export const TIZEN_MEDIA_KEYS = [
  'MediaPlayPause',
  'MediaPlay',
  'MediaPause',
  'MediaStop',
  'MediaFastForward',
  'MediaRewind',
];

export function mediaKeyAction(e: { key: string; keyCode: number }): MediaKeyAction | null {
  return BY_KEY[e.key] ?? BY_KEYCODE[e.keyCode] ?? null;
}
