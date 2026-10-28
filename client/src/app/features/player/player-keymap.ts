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

export type ShortcutCommand =
  | 'togglePlay'
  | 'seekBack'
  | 'seekForward'
  | 'seekBack30'
  | 'seekForward30'
  | 'fullscreen'
  | 'mute'
  | 'pip'
  | 'stats'
  | 'escape'
  | 'slower'
  | 'faster'
  | 'framePrev'
  | 'frameNext';

export type PlayerKeyAction =
  | { kind: 'media'; action: MediaKeyAction }
  | { kind: 'shortcut'; command: ShortcutCommand };

const SHORTCUTS: Record<string, ShortcutCommand> = {
  ' ': 'togglePlay',
  k: 'togglePlay',
  ArrowLeft: 'seekBack',
  ArrowRight: 'seekForward',
  j: 'seekBack30',
  l: 'seekForward30',
  f: 'fullscreen',
  m: 'mute',
  p: 'pip',
  s: 'stats',
  Escape: 'escape',
  '<': 'slower',
  '>': 'faster',
  ',': 'framePrev',
  '.': 'frameNext',
};

/** What a key press means (`stats` is Shift+S: the caller checks the modifier)  to a player, before any focus or visibility rule. */
export function playerKeyAction(e: { key: string; keyCode: number }): PlayerKeyAction | null {
  const action = mediaKeyAction(e);
  if (action) return { kind: 'media', action };
  const command = SHORTCUTS[e.key];
  return command ? { kind: 'shortcut', command } : null;
}
