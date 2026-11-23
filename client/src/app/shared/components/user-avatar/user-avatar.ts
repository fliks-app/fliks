import {
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import { ServerConfigService } from '../../../core/services/server-config.service';
import { initialsAvatar } from '../../../core/utils/initials-avatar';

/** A user's avatar, falling back to hashed-color initials also when the picture fails (URLs outlive files); the URL is computed so it follows the server URL, unlike a pure pipe. */
@Component({
  selector: 'app-user-avatar',
  imports: [TranslatePipe, LucideDynamicIcon],
  templateUrl: './user-avatar.html',
})
export class UserAvatarComponent {
  protected readonly icons = icons;

  private readonly serverConfig = inject(ServerConfigService);

  readonly username = input.required<string>();
  readonly avatar = input<string | null>(null);
  /** Tailwind sizing + text classes for the circle. */
  readonly size = input('w-10 h-10 text-sm');
  /** Marks the account as signed in on this device. */
  readonly checked = input(false);

  protected readonly src = computed(() => {
    const avatar = this.avatar();
    return avatar ? this.serverConfig.resolveUrl(avatar) : null;
  });
  protected readonly fallback = computed(() => initialsAvatar(this.username()));
  /** Reset by every new src, so a later working picture is retried. */
  protected readonly failed = linkedSignal<string | null, boolean>({
    source: this.src,
    computation: () => false,
  });
}
