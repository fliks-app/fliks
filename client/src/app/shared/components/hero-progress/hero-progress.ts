import { Component, input } from '@angular/core';

/** Thin progress bar with an optional caption (remaining time); renders nothing at 0. */
@Component({
  selector: 'app-hero-progress',
  templateUrl: './hero-progress.html',
})
export class HeroProgressComponent {
  readonly percent = input(0);
  readonly label = input<string | null>(null);
  readonly centered = input(false);
}
