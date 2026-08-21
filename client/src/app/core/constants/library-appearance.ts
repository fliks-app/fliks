export interface LibraryAppearanceOption {
  value: string | null;
  label?: string;
  labelKey?: string;
}

export const LIBRARY_ICON_OPTIONS: readonly LibraryAppearanceOption[] = [
  { value: null, labelKey: 'settings.libraries.icon_default' },
  { value: 'film', labelKey: 'settings.libraries.icons.film' },
  { value: 'tv', label: 'TV' },
  { value: 'popcorn', labelKey: 'settings.libraries.icons.popcorn' },
  { value: 'clapperboard', labelKey: 'settings.libraries.icons.clapperboard' },
  { value: 'book', labelKey: 'settings.libraries.icons.book' },
  { value: 'gamepad-2', labelKey: 'settings.libraries.icons.games' },
  { value: 'music', labelKey: 'settings.libraries.icons.music' },
  { value: 'heart', labelKey: 'settings.libraries.icons.heart' },
  { value: 'star', labelKey: 'settings.libraries.icons.star' },
  { value: 'globe', labelKey: 'settings.libraries.icons.globe' },
  { value: 'monitor', labelKey: 'settings.libraries.icons.monitor' },
  { value: 'users', labelKey: 'settings.libraries.icons.users' },
  { value: 'folder', labelKey: 'settings.libraries.icons.folder' },
  { value: 'swords', labelKey: 'settings.libraries.icons.swords' },
] as const;

/** daisyUI role names — proper nouns of the theme, not translated. */
export const LIBRARY_COLOR_OPTIONS: readonly LibraryAppearanceOption[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'accent', label: 'Accent' },
  { value: 'info', label: 'Info' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
] as const;

const DAISY_COLORS = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'];

/** CSS color for a library color: daisyUI role names map to their theme variable. */
export function libraryColorVar(color: string | null | undefined): string {
  const c = color || 'primary';
  return DAISY_COLORS.includes(c) ? `var(--color-${c})` : c;
}
