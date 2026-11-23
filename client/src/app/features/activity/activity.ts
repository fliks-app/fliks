import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SERVER_SINCE, ServerVersionService } from '../../core/services/server-version.service';

/** Wanted titles, the download queue and its history: one acquisition lifecycle as routed tabs. */
@Component({
  selector: 'app-activity',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslatePipe],
  templateUrl: './activity.html',
})
export class ActivityComponent {
  protected readonly hasQueue = inject(ServerVersionService).supports(SERVER_SINCE.acquisitionQueue);
}
