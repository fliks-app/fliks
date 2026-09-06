import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-subtitles-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-6">
      <div>
        <h1 class="text-2xl font-bold">{{ 'settings.subtitles.title' | translate }}</h1>
        <p class="text-sm text-base-content/60 mt-1">{{ 'settings.subtitles.subtitle' | translate }}</p>
      </div>

      <div class="flex flex-col gap-1">
        <div role="tablist" class="tabs tabs-bordered">
          <a role="tab" class="tab"
            routerLink="./"
            routerLinkActive="tab-active"
            [routerLinkActiveOptions]="{ exact: true }">
            {{ 'settings.subtitles.tab_settings' | translate }}
          </a>
          <a role="tab" class="tab"
            routerLink="./stats"
            routerLinkActive="tab-active">
            {{ 'settings.subtitles.tab_stats' | translate }}
          </a>
        </div>

        <router-outlet />
      </div>
    </div>
  `,
})
export class SubtitlesShellComponent {}
