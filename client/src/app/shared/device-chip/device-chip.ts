import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PlaybackDevice } from '../../core/services/playback-device.service';
import { DeviceIconComponent } from './device-icon';

/** Where the playback sounds: the device icon, plus its name in the accent colour while it is another device. Its press is the host's trigger. */
@Component({
  selector: 'app-device-chip',
  imports: [TranslatePipe, DeviceIconComponent],
  templateUrl: './device-chip.html',
})
export class DeviceChipComponent {
  protected readonly device = inject(PlaybackDevice);
}
