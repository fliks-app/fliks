import { Injectable, effect, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { MENU_LABEL_KEYS, type DesktopMenuLabels } from '@fliks/desktop-contract';
import { desktopBridgeOrNull } from '../plugins/desktop-player.bridge';

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
      const keys = MENU_LABEL_KEYS.map((k) => `desktop_menu.${k}`);
      void firstValueFrom(this.translate.get(keys)).then((t) =>
        bridge.setMenuLabels?.(Object.fromEntries(MENU_LABEL_KEYS.map((k, i) => [k, t[keys[i]]])) as DesktopMenuLabels),
      ).catch(() => {});
    });
  }
}
