import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { UsersApiService } from './api/users-api.service';

/**
 * Per-user library display preferences (order + hidden), persisted server-side
 * on the user so they follow the account across devices. Read reactively from
 * the auth user signal; apply to any library list before rendering.
 */
@Injectable({ providedIn: 'root' })
export class LibraryPrefsService {
  private readonly auth = inject(AuthService);
  private readonly usersApi = inject(UsersApiService);

  private order(): number[] {
    return this.auth.user()?.libraryOrder ?? [];
  }

  private hidden(): Set<number> {
    return new Set(this.auth.user()?.hiddenLibraryIds ?? []);
  }

  /** Stable sort by the saved order; ids absent from it keep their incoming
   *  order and sort after the explicitly-ordered ones. */
  private sorted<T extends { id: number }>(libs: T[]): T[] {
    const order = this.order();
    if (!order.length) return libs;
    const rank = new Map(order.map((id, i) => [id, i]));
    const at = (id: number) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
    return [...libs].sort((a, b) => at(a.id) - at(b.id));
  }

  /** Visible libraries in the user's order — for the home page and sidebar. */
  present<T extends { id: number }>(libs: T[]): T[] {
    const hidden = this.hidden();
    return this.sorted(libs).filter((l) => !hidden.has(l.id));
  }

  /** Every library in the user's order, each flagged hidden — for the modal. */
  ordered<T extends { id: number }>(libs: T[]): (T & { hidden: boolean })[] {
    const hidden = this.hidden();
    return this.sorted(libs).map((l) => ({ ...l, hidden: hidden.has(l.id) }));
  }

  /** Persist a new order + hidden set for the current user. */
  async save(libraryOrder: number[], hiddenLibraryIds: number[]): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    await this.usersApi.update(user.id, { libraryOrder, hiddenLibraryIds });
    this.auth.patchUser({ libraryOrder, hiddenLibraryIds });
  }
}
