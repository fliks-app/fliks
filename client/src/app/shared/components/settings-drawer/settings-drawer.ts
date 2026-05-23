import {
  Component, ChangeDetectionStrategy, Input, signal, OnInit, OnDestroy, ElementRef, viewChild,
} from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { inject } from '@angular/core';
import { LucideChevronLeft, LucideMenu } from '@lucide/angular';
import { TvService } from '../../../core/services/tv.service';

@Component({
  selector: 'app-settings-drawer',
  imports: [RouterOutlet, RouterLink, LucideChevronLeft, LucideMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-drawer.html',
})
export class SettingsDrawerComponent implements OnInit, OnDestroy {
  private readonly location = inject(Location);

  @Input() title = '';
  @Input() backLabel = 'Retour';
  @Input() drawerId = 'settings-drawer';

  readonly navbarHidden = signal(false);
  readonly tv = inject(TvService);

  private readonly drawerToggleEl =
    viewChild<ElementRef<HTMLInputElement>>('drawerToggle');

  private lastScrollY = 0;
  private readonly onScroll = () => {
    const y = window.scrollY;
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  ngOnInit() {
    // On TV the drawer behaves like mobile (checkbox-driven, no
    // `lg:drawer-open`). Start "open" so the user lands on /admin with
    // the sidebar visible — they navigate to a section, drawer slides
    // out, hamburger brings it back.
    if (this.tv.isTv()) {
      queueMicrotask(() => {
        const cb = this.drawerToggleEl()?.nativeElement;
        if (cb) cb.checked = true;
      });
    }
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
  }

  goBack() {
    this.location.back();
  }

  /** Click inside the menu region (TV) — close the drawer if the click
   *  hit a link so the main content takes over. No-op on desktop where
   *  `lg:drawer-open` keeps the drawer permanent. */
  onMenuClick(event: Event) {
    if (!this.tv.isTv()) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('a')) return;
    const cb = this.drawerToggleEl()?.nativeElement;
    if (cb) cb.checked = false;
  }
}
