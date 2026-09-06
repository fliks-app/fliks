import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { LucideSettings, LucidePlay, LucideCaptions, LucideCast, LucideHardDrive, LucideMonitor, LucideMonitorSmartphone, LucideHouse, LucideDownload } from '@lucide/angular';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';

@Component({
  selector: 'app-app-settings-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslatePipe,
    SettingsDrawerComponent,
    LucideSettings, LucidePlay, LucideCaptions, LucideCast, LucideHardDrive, LucideMonitor,
    LucideMonitorSmartphone, LucideHouse, LucideDownload,
  ],
  templateUrl: './app-settings-shell.html',
})
export class AppSettingsShellComponent {
  readonly tv = inject(TvService);
  readonly device = inject(DeviceService);
}
