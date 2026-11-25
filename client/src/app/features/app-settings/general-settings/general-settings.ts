import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PushService } from '../../../core/services/push.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

/** Desktop shell behaviour: what closing the window does and whether Fliks starts with the session. */
@Component({
  selector: 'app-general-settings',
  imports: [TranslatePipe, ToggleFieldComponent],
  templateUrl: './general-settings.html',
})
export class GeneralSettingsPageComponent {
  protected readonly push = inject(PushService);
}
