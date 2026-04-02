import { Injectable, signal } from '@angular/core';
import { UserRow } from '../../../../core/services/api/users-api.service';
import { RoleRow } from '../../../../core/services/api/roles-api.service';

/** Shared state between user-detail shell and its tab components. */
@Injectable()
export class UserDetailState {
  readonly user = signal<UserRow | null>(null);
  readonly roles = signal<RoleRow[]>([]);
  readonly userId = signal(0);
}
