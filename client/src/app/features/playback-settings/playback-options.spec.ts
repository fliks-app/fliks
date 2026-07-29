import {
  SIZE_OPTIONS,
  COLOR_OPTIONS,
  SHADOW_OPTIONS,
  BG_OPTIONS,
} from './playback-options';
import {
  SUBTITLE_SIZE_MAP,
  SUBTITLE_COLOR_MAP,
  SUBTITLE_SHADOW_MAP,
  SUBTITLE_BG_MAP,
} from '../../core/services/player-settings.service';

/** Every appearance value offered in the UI (settings page and the in-player
 *  panel) must be renderable — an option missing from its style map would
 *  silently fall back to the default and look like a dead control. */
const GROUPS: { name: string; options: { value: string; labelKey: string }[]; map: Record<string, string> }[] = [
  { name: 'size', options: SIZE_OPTIONS, map: SUBTITLE_SIZE_MAP },
  { name: 'color', options: COLOR_OPTIONS, map: SUBTITLE_COLOR_MAP },
  { name: 'shadow', options: SHADOW_OPTIONS, map: SUBTITLE_SHADOW_MAP },
  { name: 'background', options: BG_OPTIONS, map: SUBTITLE_BG_MAP },
];

describe('subtitle appearance options', () => {
  for (const group of GROUPS) {
    it(`${group.name}: every option is renderable and translated`, () => {
      for (const option of group.options) {
        expect(group.map[option.value]).toBeDefined();
        expect(option.labelKey).toMatch(/^playback_settings\./);
      }
      expect(Object.keys(group.map).sort()).toEqual(
        group.options.map((o) => o.value).sort(),
      );
    });
  }
});
