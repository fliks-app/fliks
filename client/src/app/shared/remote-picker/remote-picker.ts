import { Component, inject, viewChild } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCast } from '@lucide/angular';
import { DropdownMenuComponent } from '../components/dropdown-menu';
import { CastService } from '../../core/services/cast.service';
import { RemotePickerListComponent } from './remote-picker-list';

/**
 * "Play on another device" trigger for the top bar: the house
 * `app-dropdown-menu` around `app-remote-picker-list`.
 */
@Component({
  selector: 'app-remote-picker',
  imports: [TranslatePipe, DropdownMenuComponent, RemotePickerListComponent, LucideCast],
  templateUrl: './remote-picker.html',
})
export class RemotePickerComponent {
  protected readonly castService = inject(CastService);
  private readonly list = viewChild(RemotePickerListComponent);

  /** The dropdown owns its own open state, with no exposed "just opened"
   *  signal to key off, so refresh on every trigger press: a redundant GET
   *  on close is harmless. */
  protected onTriggerPress(): void {
    this.list()?.refresh();
  }
}
