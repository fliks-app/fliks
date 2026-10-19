import { Component, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCast } from '@lucide/angular';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { AirPlayService } from '../../core/services/airplay.service';
import { CastService } from '../../core/services/cast.service';
import { RemotePickerListComponent } from './remote-picker-list';

/** "Play on another device" top-bar trigger: `app-dropdown-menu` around `app-remote-picker-list`. */
@Component({
  selector: 'app-remote-picker',
  imports: [TranslatePipe, DropdownMenuComponent, RemotePickerListComponent, LucideCast],
  templateUrl: './remote-picker.html',
})
export class RemotePickerComponent {
  protected readonly castService = inject(CastService);
  protected readonly airPlay = inject(AirPlayService);
  private readonly list = viewChild(RemotePickerListComponent);

  /** The dropdown exposes no "just opened" signal, so refresh on every press; a redundant GET on close is harmless. */
  protected onTriggerPress(): void {
    this.list()?.refresh();
  }
}
