import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

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
}
