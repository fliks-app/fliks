import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';
import { armPageSlide } from '../../utils/page-slide';
import { clearPosterStamps, stampPosterNamed } from '../../utils/view-transition';

/** A person as a round avatar with the name and one line under it, linking to the person's page. */
@Component({
  selector: 'app-person-avatar-card',
  imports: [RouterLink, ResolveUrlPipe, CachedSrcDirective],
  templateUrl: './person-avatar-card.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class PersonAvatarCardComponent {
  readonly link = input.required<string | unknown[]>();
  readonly queryParams = input<Record<string, string> | null>(null);
  readonly name = input.required<string>();
  readonly avatarUrl = input<string | null>(null);
  readonly subtitle = input<string | null>(null);
  /** The page's avatar name: the card's avatar morphs into it. */
  readonly posterName = input<string | null>(null);
  /** Handed to the page so its header paints before its data arrives. */
  readonly state = input<Record<string, unknown> | undefined>(undefined);
  private readonly avatar = viewChild.required<ElementRef<HTMLElement>>('avatar');

  protected stamp(): void {
    const name = this.posterName();
    if (!name) return;
    if ('startViewTransition' in document) stampPosterNamed(this.avatar().nativeElement, name);
    else clearPosterStamps();
    armPageSlide();
  }
}
