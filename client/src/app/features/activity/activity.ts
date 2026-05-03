import { Component, ChangeDetectionStrategy, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { filter, map } from 'rxjs';

@Component({
  selector: 'app-activity',
  imports: [TranslateModule, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './activity.html',
})
export class ActivityComponent {
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  readonly pageHeadingKey = computed(() =>
    this.url().includes('/activity/subtitles') ? 'activity.tab_subtitles' : 'activity.title',
  );
}
