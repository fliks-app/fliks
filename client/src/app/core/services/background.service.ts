import { Injectable, computed, signal } from '@angular/core';

/**
 * Global page-background image, resolved from what the live pages declare.
 *
 * A page states an intent rather than writing a url, because the two states it
 * used to conflate are not the same thing. `null` means "nothing to show yet",
 * which holds whatever is on screen: a page whose data is still loading, or
 * reloading after a detour through the player, must not blank the backdrop and
 * then bring it back. An empty pool means "this page has no background", which
 * does blank it. Anything else is a pool to pick from.
 *
 * The pick is remembered per owner and pool, so returning to a page restores
 * the image it had rather than rolling a new one.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundService {
  /** Live declarations, most recent last; the last resolved one is displayed. */
  private readonly claims = signal<readonly Claim[]>([]);

  /** Current target url, or null when nothing is on offer. */
  readonly url = computed(() => {
    const resolved = this.claims().filter((c) => c.pool !== null);
    const top = resolved[resolved.length - 1];
    return top?.pick ?? null;
  });

  /**
   * Declare what `owner` wants shown: a pool to pick from, `[]` for no
   * background, or `null` while it does not know yet.
   */
  set(owner: object, pool: readonly string[] | null): void {
    this.claims.update((claims) => {
      const previous = claims.find((c) => c.owner === owner);
      const next: Claim = { owner, ...resolve(pool, previous) };
      // Newest declaration on top: the page arriving is the one speaking, and
      // it takes the backdrop from the page it covers. Cached pages keep their
      // declaration underneath, so leaving hands it back rather than blanking.
      return [...claims.filter((c) => c.owner !== owner), next];
    });
  }

  /** Drop a page's declaration; the one below it takes over. */
  release(owner: object): void {
    this.claims.update((claims) => claims.filter((c) => c.owner !== owner));
  }
}

interface Claim {
  owner: object;
  /** null while the owner has nothing to say yet. */
  pool: readonly string[] | null;
  pick: string | null;
}

/** Keep the pick while its pool is unchanged, so a re-emit never re-rolls. */
function resolve(
  pool: readonly string[] | null,
  previous: Claim | undefined,
): { pool: readonly string[] | null; pick: string | null } {
  if (pool === null) return { pool: null, pick: previous?.pick ?? null };
  const next = pool.filter((u) => !!u);
  if (next.length === 0) return { pool: next, pick: null };
  if (previous?.pick && previous.pool && samePool(next, previous.pool)) {
    return { pool: next, pick: previous.pick };
  }
  return { pool: next, pick: next[Math.floor(Math.random() * next.length)] };
}

/** Pools are equal when they hold the same urls in the same order. */
function samePool(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}
