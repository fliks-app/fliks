// SDL KMOD_* masks (left | right).
const KMOD_SHIFT = 0x0003;
const KMOD_CTRL = 0x00c0;
const KMOD_ALT = 0x0300;
const KMOD_GUI = 0x0c00;

// SDL_GetKeyName names that differ from Electron's key codes; letters, digits, punctuation and F1-F12 pass through.
const NAMED: Record<string, string> = {
  Return: 'Enter',
  'Keypad Enter': 'Enter',
  'Page Up': 'PageUp',
  'Page Down': 'PageDown',
  AudioPlay: 'MediaPlayPause',
  'Audio Play': 'MediaPlayPause',
  MediaPlayPause: 'MediaPlayPause',
  AudioStop: 'MediaStop',
  AudioNext: 'MediaNextTrack',
  AudioPrev: 'MediaPreviousTrack',
  AudioMute: 'VolumeMute',
  Mute: 'VolumeMute',
  VolumeUp: 'VolumeUp',
  VolumeDown: 'VolumeDown',
};

const MODIFIER_KEYS = /^(Left|Right) (Shift|Ctrl|Alt|GUI)$/;

export interface ElectronKey {
  keyCode: string;
  modifiers: string[];
}

/** Maps an SDL key event to Electron's sendInputEvent key; null for pure modifier presses and unknown keys. */
export function toElectronKey(name: string, mod: number): ElectronKey | null {
  if (!name || MODIFIER_KEYS.test(name)) return null;
  const keyCode = NAMED[name] ?? (name.length === 1 ? name.toLowerCase() : name);
  // Names such as "Keypad 5" or "Caps Lock" are not key codes Electron knows.
  if (keyCode.length > 1 && !/^(F\d{1,2}|[A-Z][A-Za-z]+)$/.test(keyCode)) return null;
  if (keyCode.includes(' ')) return null;
  const modifiers: string[] = [];
  if (mod & KMOD_SHIFT) modifiers.push('shift');
  if (mod & KMOD_CTRL) modifiers.push('control');
  if (mod & KMOD_ALT) modifiers.push('alt');
  if (mod & KMOD_GUI) modifiers.push('meta');
  return { keyCode, modifiers };
}
