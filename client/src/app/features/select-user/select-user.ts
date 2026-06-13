import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { Capacitor } from '@capacitor/core';
import { AuthService, PublicUserSummary } from '../../core/services/auth.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { ServerCacheService } from '../../core/services/server-cache.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { initialsAvatar } from '../../core/utils/initials-avatar';
import { LucideMonitorSmartphone, LucideKeyRound, LucideUserRoundPen } from '@lucide/angular';

@Component({
  selector: 'app-select-user',
  imports: [
    TranslateModule,
    LucideMonitorSmartphone,
    LucideKeyRound,
    LucideUserRoundPen,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './select-user.html',
})
export class SelectUserComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly serverCache = inject(ServerCacheService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly destroyRef = inject(DestroyRef);

  readonly users = signal<PublicUserSummary[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  /** id of the user whose action sheet is open, or null. */
  readonly openSheetFor = signal<number | null>(null);
  readonly isNative = this.serverConfig.isNative;
  /** Show the "change server" affordance on every standalone bundle — both
   *  Capacitor (mobile native) and Smart TV (both folded into `isNative`).
   *  Web is served by the backend itself and has no notion of switching
   *  origins. */
  readonly canChangeServer = this.isNative;

  /** Default-focus target inside the sheet (password button). Captured as a
   *  view child so the effect below can pull focus to it the moment the
   *  sheet opens — `data-tv-modal` on the sheet container already traps
   *  D-pad navigation inside (see `tv-spatial-nav.service.ts`). */
  private readonly passwordBtn = viewChild<ElementRef<HTMLButtonElement>>('passwordBtn');

  /** Stable identity for the dismiss-stack registration so the same
   *  callback can be `remove()`-d as was `push()`-ed even if `closeSheet`
   *  fires multiple times (open → cancel → reopen). */
  private readonly dismissCallback = () => this.closeSheet();
  private dismissRegistered = false;

  constructor() {
    void this.loadUsers();
    // Sheet lifecycle: focus the password button on open and register a
    // back-dismiss callback so the app-shell back handler
    // (App.handleBackButton — Tizen XF86Back / Capacitor backButton /
    // Android hardware) closes the sheet before any route-level back.
    // The viewChild is null on the first effect tick (sheet not yet
    // materialised by @if); rAF lands after Angular's commit pass.
    effect(() => {
      const open = this.openSheetFor() !== null;
      if (open && !this.dismissRegistered) {
        this.dismissStack.push(this.dismissCallback);
        this.dismissRegistered = true;
      } else if (!open && this.dismissRegistered) {
        this.dismissStack.remove(this.dismissCallback);
        this.dismissRegistered = false;
      }
      if (!open) return;
      requestAnimationFrame(() => {
        this.passwordBtn()?.nativeElement.focus({ preventScroll: true });
      });
    });

    // Belt: if the component is torn down while the sheet is open
    // (route change, auth flow restarting), drop the dismiss callback
    // so the stack doesn't grow a dangling reference that would
    // swallow the next back press elsewhere.
    this.destroyRef.onDestroy(() => {
      if (this.dismissRegistered) {
        this.dismissStack.remove(this.dismissCallback);
        this.dismissRegistered = false;
      }
    });
  }

  async loadUsers() {
    this.loading.set(true);
    this.error.set('');
    try {
      const list = await this.auth.listUsersPublic();
      this.users.set(list);
    } catch {
      this.error.set('select_user.load_error');
    } finally {
      this.loading.set(false);
    }
  }

  selectUser(user: PublicUserSummary) {
    this.openSheetFor.set(user.id);
  }

  closeSheet() {
    this.openSheetFor.set(null);
  }

  goToPasswordLogin(user: PublicUserSummary) {
    void this.router.navigate(['/login'], { queryParams: { username: user.username } });
  }

  goToQuickConnect(user: PublicUserSummary) {
    void this.router.navigate(['/quick-connect', user.id]);
  }

  goToOtherUser() {
    void this.router.navigate(['/login']);
  }

  async changeServer() {
    await this.serverCache.clearAll();
    await this.serverConfig.clear();
    // Drop the old server's access/refresh/stream tokens too — clearAll only
    // wipes cached view data, leaving credentials that the next server rejects.
    await this.auth.resetForServerSwitch();
    void this.router.navigate(['/setup']);
  }

  /**
   * Stable color + initials from a username for users without an avatar.
   * Pure function — exposed on the component so the template can read it.
   */
  initials(name: string) {
    return initialsAvatar(name);
  }
}
