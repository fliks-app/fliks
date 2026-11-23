import { Component } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SettingsDrawerComponent, type SettingsNavItem } from '../../shared/components/settings-drawer/settings-drawer';
import { icons } from '../../shared/icons';

const item = (id: string, icon: SettingsNavItem['icon'], route = id): SettingsNavItem => ({
  id,
  route: `/account/${route}`,
  labelKey: `account_settings.nav.${id}`,
  icon,
});

@Component({
  selector: 'app-account-shell',
  imports: [TranslatePipe, SettingsDrawerComponent],
  templateUrl: './account-shell.html',
})
export class AccountShellComponent {
  protected readonly icons = icons;

  protected readonly sections = [{
    id: 'account',
    items: [
      item('general', icons.SlidersHorizontal),
      item('password', icons.Lock),
      item('privacy', icons.Users),
      item('spoilers', icons.EyeOff),
      item('devices', icons.TabletSmartphone),
      item('email_devices', icons.Mail, 'email-devices'),
    ],
  }];
}
