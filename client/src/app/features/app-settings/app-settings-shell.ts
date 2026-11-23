import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../shared/icons';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { PushService } from '../../core/services/push.service';
import { environment } from '../../../environments/environment';

@Component({
  selector: 'app-app-settings-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslatePipe,
    SettingsDrawerComponent, LucideDynamicIcon],
  templateUrl: './app-settings-shell.html',
})
export class AppSettingsShellComponent {
  protected readonly icons = icons;

  readonly tv = inject(TvService);
  readonly device = inject(DeviceService);
  readonly push = inject(PushService);
  readonly version = environment.version;
}
