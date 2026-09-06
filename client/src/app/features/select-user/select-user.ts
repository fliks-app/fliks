import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService, PublicUserSummary } from '../../core/services/auth.service';
import { DismissableStackService } from '../../core/services/dismissable-stack.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { ToastService } from '../../core/services/toast.service';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { LucideMonitorSmartphone, LucideKeyRound, LucideUserRoundPen } from '@lucide/angular';

@Component({
  selector: 'app-select-user',
  imports: [
    TranslatePipe,
    LucideMonitorSmartphone,
    LucideKeyRound,
    LucideUserRoundPen,
    UserAvatarComponent,
    DefaultFocusDirective,
  ],
  templateUrl: './select-user.html',
})
export class SelectUserComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly dismissStack = inject(DismissableStackService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly serverUsers = signal<PublicUserSummary[]>([]);
  readonly loading = signal(true);
  readonly unreachable = signal(false);
  /** id of the user whose action sheet is open, or null. */
  readonly openSheetFor = signal<number | null>(null);
  /** id of the user being signed back in, or null. */
  readonly resuming = signal<number | null>(null);
  /** Only a standalone bundle can point elsewhere: web is served by the very
   *  backend it talks to. */
  readonly canChangeServer = this.serverConfig.isNative;

  /** Accounts with a session on this device: no password needed to get back in. */
  private readonly resumableIds = computed(
    () => new Set(this.auth.resumableSessions().map((s) => s.user.id)),
  );

  /**
   * The server's roster, plus the accounts this device has a session for. The
   * union matters when the server is unreachable: a stored session is exactly
   * what lets someone back into their downloaded media offline.
   */
  readonly users = computed<PublicUserSummary[]>(() => {
    const byId = new Map<number, PublicUserSummary>();
    for (const session of this.auth.resumableSessions()) {
      byId.set(session.user.id, {
        id: session.user.id,
        username: session.user.username,
        avatar: session.user.avatar,
      });
    }
    for (const user of this.serverUsers()) byId.set(user.id, user);
    return [...byId.values()].sort((a, b) => a.username.localeCompare(b.username));
  });

  readonly selectedUser = computed(
    () => this.users().find((u) => u.id === this.openSheetFor()) ?? null,
  );

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
    this.unreachable.set(false);
    try {
      this.serverUsers.set(await this.auth.listUsersPublic());
    } catch {
      this.unreachable.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  hasSession(user: PublicUserSummary): boolean {
    return this.resumableIds().has(user.id);
  }

  /** One tap on an account with a stored session signs straight back in;
   *  anything else opens the password / quick-connect sheet. */
  async selectUser(user: PublicUserSummary) {
    if (this.resuming() !== null) return;
    if (!this.hasSession(user)) {
      this.openSheetFor.set(user.id);
      return;
    }
    // The tile stays enabled while resuming: disabling it would blur it, and a
    // TV remote has nowhere to go from a blurred page.
    this.resuming.set(user.id);
    try {
      const outcome = await this.auth.resumeSession(user.id);
      if (outcome === 'resumed') {
        await this.router.navigate(['/'], { replaceUrl: true });
        return;
      }
      if (outcome === 'unreachable') {
        this.toast.error(this.translate.instant('errors.network'));
        return;
      }
      this.toast.info(this.translate.instant('select_user.session_expired'));
      this.openSheetFor.set(user.id);
    } finally {
      this.resuming.set(null);
    }
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

  /** Stored sessions — including the current one — survive: /setup is where the
   *  server is picked, and picking one resumes its session. */
  changeServer() {
    void this.router.navigate(['/setup']);
  }
}
