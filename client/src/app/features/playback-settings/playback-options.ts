/** Shared option lists for playback settings pages. */

export const LANGUAGE_OPTIONS = [
  { value: '', label: 'Aucune préférence' },
  { value: 'fra', label: 'Français' },
  { value: 'eng', label: 'English' },
  { value: 'jpn', label: '日本語 (Japanese)' },
  { value: 'deu', label: 'Deutsch (German)' },
  { value: 'spa', label: 'Español (Spanish)' },
  { value: 'ita', label: 'Italiano (Italian)' },
  { value: 'por', label: 'Português (Portuguese)' },
  { value: 'kor', label: '한국어 (Korean)' },
  { value: 'zho', label: '中文 (Chinese)' },
  { value: 'rus', label: 'Русский (Russian)' },
  { value: 'ara', label: 'العربية (Arabic)' },
];

export const SUBTITLE_MODE_OPTIONS = [
  { value: 'off', labelKey: 'playback_settings.sub_mode_off' },
  { value: 'intelligent', labelKey: 'playback_settings.sub_mode_intelligent' },
  { value: 'always', labelKey: 'playback_settings.sub_mode_always' },
];

export const SIZE_OPTIONS = [
  { value: 'small', label: 'Petit' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Grand' },
  { value: 'xlarge', label: 'Très grand' },
];

export const COLOR_OPTIONS = [
  { value: 'white', label: 'Blanc' },
  { value: 'yellow', label: 'Jaune' },
  { value: 'green', label: 'Vert' },
  { value: 'cyan', label: 'Cyan' },
];

export const SHADOW_OPTIONS = [
  { value: 'none', label: 'Aucune' },
  { value: 'drop', label: 'Ombre portée' },
  { value: 'outline', label: 'Contour' },
  { value: 'raised', label: 'Relief' },
];

export const BG_OPTIONS = [
  { value: 'transparent', label: 'Transparent' },
  { value: 'semi', label: 'Noir semi-transparent' },
  { value: 'black', label: 'Noir' },
];

export const BOTTOM_MARGIN_OPTIONS = [0, 5, 10, 15, 20];
export const TOP_MARGIN_OPTIONS = [0, 5, 10, 15];

export const QUALITY_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: '2160p', label: '4K (2160p)' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];

export const AUDIO_CHANNEL_OPTIONS = [
  { value: 2, label: 'Stéréo (2.0)' },
  { value: 6, label: 'Surround 5.1' },
  { value: 8, label: 'Surround 7.1' },
];
