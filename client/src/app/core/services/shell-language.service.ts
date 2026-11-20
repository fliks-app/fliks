import { Injectable, effect, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { desktopBridgeOrNull } from '../plugins/desktop-player.bridge';

const MENU_KEYS = [
  'about', 'services', 'hide', 'hideOthers', 'showAll', 'quit', 'edit', 'undo', 'redo', 'cut', 'copy', 'paste',
  'selectAll', 'view', 'enterFullScreen', 'exitFullScreen', 'window', 'minimize', 'zoom', 'close', 'bringAllToFront',
  'playback', 'playPause', 'stop', 'skipBack', 'skipForward',
];

/** Hands the UI language to what is outside the page's own text: the document's `lang` and the desktop shell's application menu. */
@Injectable({ providedIn: 'root' })
export class ShellLanguageService {
  private readonly translate = inject(TranslateService);

  constructor() {
    effect(() => {
      const lang = this.translate.currentLang();
      if (lang) document.documentElement.lang = lang;
      const bridge = desktopBridgeOrNull();
      if (!bridge?.setMenuLabels) return;
      const keys = MENU_KEYS.map((k) => `desktop_menu.${k}`);
      void firstValueFrom(this.translate.get(keys)).then((t) =>
        bridge.setMenuLabels?.(Object.fromEntries(MENU_KEYS.map((k, i) => [k, t[keys[i]]]))),
      ).catch(() => {});
    });
  }
}
