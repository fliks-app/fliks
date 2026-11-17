import { Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { DeviceService } from '../../../core/services/device.service';
import { PartyService } from '../../../core/services/party/party.service';

/** The next rows of the party's programme with their singers; shown only while some are waiting. */
@Component({
  selector: 'app-karaoke-queue',
  imports: [TranslatePipe],
  templateUrl: './karaoke-queue.html',
})
export class KaraokeQueueComponent {
  protected readonly party = inject(PartyService);
  protected readonly tv = inject(DeviceService).isTv;
}
