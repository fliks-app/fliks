import { Injectable, inject, DestroyRef } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * Auto-reload the PWA when the Angular service worker has fetched a new
 * version and marked it ready to activate.
 *
 * We don't prompt the user — the reload is unconditional. A version
 * mismatch between the loaded app shell and a lazy chunk (their hashed
 * filenames change between builds) crashes the route loader with
 * `ChunkLoadError`, so the reload-on-VERSION_READY trade is "one extra
 * reload at deploy time" against "broken navigation until the user
 * happens to refresh manually". Worth it.
 *
 * Why `document.location.reload()` and not `swUpdate.activateUpdate()`:
 * activateUpdate atomically swaps the SW to the new version inside the
 * same tab, but the loaded JS still has the old chunk hashes — the next
 * lazy import 404s. A full reload re-pulls index.html from the new SW,
 * which then serves the new asset map. See the Angular SW comms doc:
 * https://angular.dev/ecosystem/service-workers/communications
 *
 * Gated to web builds only — Capacitor native apps update via the store
 * (Play Store / App Store) and have no Angular service worker.
 */
@Injectable({ providedIn: 'root' })
export class PwaAutoUpdateService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);

  init(): void {
    if (!this.swUpdate.isEnabled) return;

    const sub = this.swUpdate.versionUpdates
      .pipe(filter((evt): evt is VersionReadyEvent => evt.type === 'VERSION_READY'))
      .subscribe(() => {
        document.location.reload();
      });

    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }
}
