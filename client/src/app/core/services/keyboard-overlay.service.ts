import { Injectable, signal } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

interface KeyboardOverlayPlugin {
  setKeyboardOverlay(options: { enabled: boolean }): Promise<void>;
}

const Immersive = registerPlugin<KeyboardOverlayPlugin>('Immersive');

/** Lets the soft keyboard cover the UI instead of resizing the WebView; `height` (CSS px) is for what must stay above it. Native only. */
@Injectable({ providedIn: 'root' })
export class KeyboardOverlayService {
  readonly height = signal(0);

  private users = 0;
  private handles: Promise<PluginListenerHandle>[] = [];
  private previousResize: KeyboardResize | null = null;

  enter(): void {
    if (!Capacitor.isNativePlatform() || this.users++ > 0) return;
    if (Capacitor.getPlatform() === 'ios') {
      void Keyboard.getResizeMode()
        .then((r) => {
          if (this.users === 0) return;
          this.previousResize = r.mode;
          return Keyboard.setResizeMode({ mode: KeyboardResize.None });
        })
        .catch(() => {});
      const show = (info: { keyboardHeight: number }) => this.height.set(info.keyboardHeight);
      this.handles = [
        Keyboard.addListener('keyboardWillShow', show),
        Keyboard.addListener('keyboardDidShow', show),
        Keyboard.addListener('keyboardWillHide', () => this.height.set(0)),
      ];
    } else {
      // The plugin's height counts insets outside the WebView; MainActivity measures the overlap itself.
      addEventListener('imeOverlap', this.onOverlap);
      Immersive.setKeyboardOverlay({ enabled: true }).catch(() => {});
    }
  }

  private readonly onOverlap = (e: Event) => this.height.set((e as CustomEvent<{ height: number }>).detail.height);

  leave(): void {
    if (!Capacitor.isNativePlatform() || this.users === 0 || --this.users > 0) return;
    for (const h of this.handles) void h.then((x) => x.remove()).catch(() => {});
    this.handles = [];
    this.height.set(0);
    if (Capacitor.getPlatform() === 'ios') {
      if (this.previousResize) Keyboard.setResizeMode({ mode: this.previousResize }).catch(() => {});
      this.previousResize = null;
    } else {
      removeEventListener('imeOverlap', this.onOverlap);
      Immersive.setKeyboardOverlay({ enabled: false }).catch(() => {});
    }
  }
}
