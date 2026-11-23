import { Component, input } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../icons';
import type { DeviceIcon } from '../../core/utils/device-icon';

/** Lucide owns the svg's class attribute, so the classes go through `[class]` on the svg itself. */
@Component({
  selector: 'app-device-icon',
  imports: [LucideDynamicIcon],
  styles: [':host { display: contents; }'],
  templateUrl: './device-icon.html',
})
export class DeviceIconComponent {
  protected readonly icons = icons;

  readonly icon = input.required<DeviceIcon>();
  readonly iconClass = input('h-5 w-5 shrink-0');
}
