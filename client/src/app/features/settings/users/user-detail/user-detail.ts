import {
  Component,
  ChangeDetectionStrategy,
  inject,
  OnInit,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LucideChevronLeft, LucideUser } from '@lucide/angular';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { UsersApiService } from '../../../../core/services/api/users-api.service';
import { RolesApiService } from '../../../../core/services/api/roles-api.service';
import { AuthService } from '../../../../core/services/auth.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { UserDetailState } from './user-detail.state';

@Component({
  selector: 'app-user-detail',
  imports: [LucideChevronLeft, LucideUser, TranslatePipe, RouterLink, RouterLinkActive, RouterOutlet],
  providers: [UserDetailState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-detail.html',
})
export class UserDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(UsersApiService);
  private readonly rolesApi = inject(RolesApiService);
  private readonly translate = inject(TranslateService);
  readonly auth = inject(AuthService);
  private readonly confirmation = inject(ConfirmationService);
  readonly state = inject(UserDetailState);

  async ngOnInit() {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!Number.isFinite(id) || id < 1) {
      this.state.user.set(null);
      return;
    }
    this.state.userId.set(id);

    try {
      const [user, roles] = await Promise.all([
        this.api.get(id),
        this.rolesApi.list(),
      ]);
      this.state.user.set(user);
      this.state.roles.set(roles);
    } catch {
      this.state.user.set(null);
    }
  }

  async deleteUser() {
    const user = this.state.user();
    if (!user) return;
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('settings.users.confirm_delete', {
          name: user.username,
        }),
        variant: 'danger',
      }))
    )
      return;
    try {
      await this.api.remove(user.id);
      void this.router.navigate(['/admin/settings/users']);
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? 'Error',
        variant: 'danger',
      });
    }
  }
}
