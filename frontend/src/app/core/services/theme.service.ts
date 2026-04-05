import { Injectable, signal, effect } from '@angular/core';

function getInitialTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem('suitarr-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<'dark' | 'light'>(getInitialTheme());

  private readonly applyEffect = effect(() => {
    const t = this.theme();
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('suitarr-theme', t);
  });

  toggle() {
    this.theme.update(t => t === 'dark' ? 'light' : 'dark');
  }
}
