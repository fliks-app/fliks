import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SettingsDrawerComponent } from '../../shared/components/settings-drawer/settings-drawer';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../shared/icons';
import { SERVER_SINCE, ServerVersionService } from '../../core/services/server-version.service';

@Component({
  selector: 'app-account-shell',
  imports: [
    RouterLink, RouterLinkActive, TranslatePipe,
    SettingsDrawerComponent, LucideDynamicIcon],
  templateUrl: './account-shell.html',
})
export class AccountShellComponent {
  protected readonly icons = icons;

  private readonly versions = inject(ServerVersionService);
  readonly whatsNew = computed(() => this.versions.supports(SERVER_SINCE.whatsNew));
  readonly continueSync = computed(() => this.versions.supports(SERVER_SINCE.sessionSync));
}
