/** Shared option lists for playback settings pages. */

export interface PlaybackOption {
  value: string;
  label?: string;
  labelKey?: string;
}

export const LANGUAGE_OPTIONS: readonly PlaybackOption[] = [
  { value: '', labelKey: 'playback_settings.lang_any' },
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
  { value: 'xsmall', labelKey: 'playback_settings.sub_size_xsmall' },
  { value: 'small', labelKey: 'playback_settings.sub_size_small' },
  { value: 'normal', labelKey: 'playback_settings.sub_size_normal' },
  { value: 'large', labelKey: 'playback_settings.sub_size_large' },
  { value: 'xlarge', labelKey: 'playback_settings.sub_size_xlarge' },
];

export const COLOR_OPTIONS = [
  { value: 'white', labelKey: 'playback_settings.sub_color_white' },
  { value: 'yellow', labelKey: 'playback_settings.sub_color_yellow' },
  { value: 'green', labelKey: 'playback_settings.sub_color_green' },
  { value: 'cyan', labelKey: 'playback_settings.sub_color_cyan' },
];

export const SHADOW_OPTIONS = [
  { value: 'none', labelKey: 'playback_settings.sub_shadow_none' },
  { value: 'drop', labelKey: 'playback_settings.sub_shadow_drop' },
  { value: 'outline', labelKey: 'playback_settings.sub_shadow_outline' },
  { value: 'raised', labelKey: 'playback_settings.sub_shadow_raised' },
];

export const BG_OPTIONS = [
  { value: 'transparent', labelKey: 'playback_settings.sub_bg_transparent' },
  { value: 'semi', labelKey: 'playback_settings.sub_bg_semi' },
  { value: 'black', labelKey: 'playback_settings.sub_bg_black' },
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
  { value: 2, label: 'Stereo (2.0)' },
  { value: 6, label: 'Surround 5.1' },
  { value: 8, label: 'Surround 7.1' },
];
