import { Component, ChangeDetectionStrategy, Input, signal, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { inject } from '@angular/core';
import { LucideChevronLeft, LucideMenu } from '@lucide/angular';

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
  private lastScrollY = 0;
  private readonly onScroll = () => {
    const y = window.scrollY;
    if (Math.abs(y - this.lastScrollY) < 10) return;
    this.navbarHidden.set(y > this.lastScrollY && y > 56);
    this.lastScrollY = y;
  };

  ngOnInit() {
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
  }

  goBack() {
    this.location.back();
  }
}
