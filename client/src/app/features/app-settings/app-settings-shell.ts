import { Component, computed, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SettingsDrawerComponent, type SettingsNavItem } from '../../shared/components/settings-drawer/settings-drawer';
import { icons } from '../../shared/icons';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { PushService } from '../../core/services/push.service';
import { environment } from '../../../environments/environment';

const item = (id: string, icon: SettingsNavItem['icon']): SettingsNavItem => ({
  id,
  route: `/app-settings/${id}`,
  labelKey: `app_settings.nav.${id}`,
  icon,
});

@Component({
  selector: 'app-app-settings-shell',
  imports: [TranslatePipe, SettingsDrawerComponent],
  templateUrl: './app-settings-shell.html',
})
export class AppSettingsShellComponent {
  protected readonly icons = icons;

  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  private readonly push = inject(PushService);
  readonly version = environment.version;

  protected readonly sections = computed(() => {
    const isTv = this.tv.isTv();
    return [{
      id: 'app',
      items: [
        ...(this.device.isDesktopNative() ? [item('general', icons.Settings)] : []),
        item('home', icons.House),
        item('display', icons.Monitor),
        item('player', icons.Play),
        item('subtitles', icons.Captions),
        // No Chromecast sender on a TV: it is a target, not a sender.
        ...(isTv ? [] : [item('cast', icons.Cast)]),
        item('remote', icons.MonitorSmartphone),
        ...(this.push.serverSupported() ? [item('notifications', icons.Bell)] : []),
        ...(isTv ? [] : [item('storage', icons.HardDrive)]),
        ...(this.device.isDesktopNative() ? [item('update', icons.Download)] : []),
      ],
    }];
  });
}
