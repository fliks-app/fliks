import { Component, computed, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';

/** A badge of the meta row, with its daisyUI classes. */
export interface HeroChip {
  /** A translation key, or a name that has none (a library) and shows as is. */
  label: string;
  cls: string;
}

/** The facts line under a hero title: rating, plain-text parts and badges. */
@Component({
  selector: 'app-hero-meta-row',
  imports: [DecimalPipe, TranslatePipe],
  templateUrl: './hero-meta-row.html',
})
export class HeroMetaRowComponent {
  readonly rating = input<number | null>(null);
  readonly parts = input<string[]>([]);
  readonly chips = input<HeroChip[]>([]);
  /** Desktop spacing; the mobile row sits tighter. */
  readonly desktop = input(true);
  readonly centered = input(false);
  /** Over a picture: full-contrast text with the hero text shadow. */
  readonly onPicture = input(false);
  readonly visible = computed(() => !!(this.rating() || this.parts().length || this.chips().length));
}
