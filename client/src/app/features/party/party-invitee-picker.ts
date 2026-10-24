import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, model, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { SocialApiService, type SocialUser } from '../../core/services/api/social-api.service';
import { AuthService } from '../../core/services/auth.service';
import { UserAvatarComponent } from '../../shared/components/user-avatar/user-avatar';

/** Checklist of the users the caller follows, minus `exclude`; the picked ids go out through `selected`. */
@Component({
  selector: 'app-party-invitee-picker',
  imports: [TranslatePipe, UserAvatarComponent],
  templateUrl: './party-invitee-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PartyInviteePickerComponent implements OnInit {
  private readonly social = inject(SocialApiService);
  private readonly auth = inject(AuthService);

  readonly exclude = input<number[]>([]);
  readonly selected = model<number[]>([]);

  private readonly following = signal<SocialUser[] | null>(null);
  protected readonly users = computed(() => (this.following() ?? []).filter((u) => !this.exclude().includes(u.id)));
  protected readonly loading = computed(() => this.following() === null);

  async ngOnInit(): Promise<void> {
    const me = this.auth.user();
    this.following.set(me ? await this.social.listFollowing(me.id).catch(() => []) : []);
  }

  protected toggle(id: number, checked: boolean): void {
    this.selected.update((l) => (checked ? [...l, id] : l.filter((x) => x !== id)));
  }
}
