import { Component, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { PushService } from '../../../core/services/push.service';
import { icons } from '../../icons';

/** Home banner offering notifications on the desktop and mobile apps; it can be hidden, never refused. */
@Component({
  selector: 'app-notify-banner',
  imports: [TranslatePipe, LucideDynamicIcon],
  templateUrl: './notify-banner.html',
})
export class NotifyBannerComponent {
  protected readonly icons = icons;
  protected readonly push = inject(PushService);

  /** Adds bottom padding when stacked above the home sections. */
  readonly padding = input(false);
}
