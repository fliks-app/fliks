import { Component, input } from '@angular/core';
import { LucideAirplay, LucideCast, LucideMonitor, LucideSmartphone, LucideTablet, LucideTv } from '@lucide/angular';
import type { DeviceIcon } from '../../core/utils/device-icon';

/** Lucide owns the svg's class attribute, so the classes go through `[class]` on the svg itself. */
@Component({
  selector: 'app-device-icon',
  imports: [LucideAirplay, LucideCast, LucideMonitor, LucideSmartphone, LucideTablet, LucideTv],
  styles: [':host { display: contents; }'],
  templateUrl: './device-icon.html',
})
export class DeviceIconComponent {
  readonly icon = input.required<DeviceIcon>();
  readonly iconClass = input('h-5 w-5 shrink-0');
}
