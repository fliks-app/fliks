import { Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** Thin progress bar with an optional caption (remaining time); the bar shows only between 0 and 100, the caption whenever it is set. */
@Component({
  selector: 'app-hero-progress',
  imports: [TranslatePipe],
  templateUrl: './hero-progress.html',
})
export class HeroProgressComponent {
  readonly percent = input(0);
  readonly label = input<string | null>(null);
  readonly centered = input(false);
}
