import { Injectable, signal, effect } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

function getInitialTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem('fliks-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<'dark' | 'light'>(getInitialTheme());

  private readonly applyEffect = effect(() => {
    const t = this.theme();
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('fliks-theme', t);
    // Mirror to Capacitor Preferences (Android: SharedPreferences file
    // "CapacitorStorage") so MainActivity can read the persisted theme before
    // super.onCreate and pick a matching splash variant on the next cold start.
    if (Capacitor.isNativePlatform()) {
      void Preferences.set({ key: 'fliks-theme', value: t });
    }
  });

  toggle() {
    this.theme.update(t => t === 'dark' ? 'light' : 'dark');
  }
}
