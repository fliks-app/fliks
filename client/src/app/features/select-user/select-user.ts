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
import { restoreOpenerFocus } from '../../core/services/focusable.constants';
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

  /** The server's roster plus accounts with a session on this device; the union lets someone back into downloaded media offline. */
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

  /** Tile the default-focus pass lands on: an account with a stored session, else the first (else boot stays unfocused until `DefaultFocusService` times out). */
  readonly focusTileId = computed(
    () => this.users().find((u) => this.hasSession(u))?.id ?? this.users()[0]?.id ?? null,
  );

  /** Password button, focused when the sheet opens; `data-tv-modal` already traps D-pad navigation (see `tv-spatial-nav.service.ts`). */
  private readonly passwordBtn = viewChild<ElementRef<HTMLButtonElement>>('passwordBtn');

  /** Stable identity so the callback pushed on the dismiss stack can be `remove()`-d even if `closeSheet` fires repeatedly. */
  private readonly dismissCallback = () => this.closeSheet();
  private dismissRegistered = false;
  /** Tile the sheet was opened from, so closing hands focus back to it
   *  instead of dropping it on `<body>`. */
  private opener: HTMLElement | null = null;

  constructor() {
    void this.loadUsers();
    // Sheet lifecycle: focus the password button on open and register a back-dismiss callback.
    // The viewChild is null on the first tick (@if not yet materialised); rAF lands after Angular's commit pass.
    effect(() => {
      const open = this.openSheetFor() !== null;
      if (open && !this.dismissRegistered) {
        this.dismissStack.push(this.dismissCallback);
        this.dismissRegistered = true;
      } else if (!open && this.dismissRegistered) {
        this.dismissStack.remove(this.dismissCallback);
        this.dismissRegistered = false;
      }
      if (!open) {
        const opener = this.opener;
        this.opener = null;
        // rAF as on open: the sheet's focused button stays in the DOM until the commit pass, and its removal would blur the restored focus.
        if (opener) requestAnimationFrame(() => restoreOpenerFocus(opener));
        return;
      }
      requestAnimationFrame(() => {
        this.passwordBtn()?.nativeElement.focus({ preventScroll: true });
      });
    });

    // Drop the dismiss callback if torn down while open, so a dangling entry doesn't swallow the next back press.
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
    this.opener = document.activeElement as HTMLElement | null;
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
