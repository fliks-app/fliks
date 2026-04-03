import { Injectable, Injector, afterNextRender, inject } from '@angular/core';
import { Router, NavigationStart } from '@angular/router';

@Injectable({ providedIn: 'root' })
export class ScrollMemoryService {
  private positions = new Map<string, number>();
  private currentKey: string | null = null;
  private readonly router = inject(Router);

  constructor() {
    // Save scroll position BEFORE navigation starts (scroll is still intact)
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart && this.currentKey) {
        this.positions.set(this.currentKey, window.scrollY);
      }
    });
  }

  /** Call on component init to register which key to track. */
  activate(key: string) {
    this.currentKey = key;
  }

  /** Call on component destroy to stop tracking. */
  deactivate() {
    this.currentKey = null;
  }

  /**
   * Restore scroll position after Angular has rendered.
   */
  restore(key: string, injector: Injector) {
    const y = this.positions.get(key);
    if (!y) return;
    afterNextRender(() => {
      window.scrollTo(0, y);
    }, { injector });
  }
}
