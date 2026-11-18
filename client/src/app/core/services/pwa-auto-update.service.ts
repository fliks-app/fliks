import { Injectable, inject, DestroyRef, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/** Reloads the PWA unconditionally when the service worker has a new version ready: hashed lazy chunks of the old shell would 404 (`ChunkLoadError`).
 * A full reload, not `activateUpdate()`, since the loaded JS keeps the old chunk hashes; web builds only. */
@Injectable({ providedIn: 'root' })
export class PwaAutoUpdateService {
  private readonly swUpdate = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);
  /** True while the new version downloads, until the reload. */
  readonly installing = signal(false);

  init(): void {
    if (!this.swUpdate.isEnabled) return;

    const sub = this.swUpdate.versionUpdates.subscribe((evt) => {
      if (evt.type === 'VERSION_DETECTED') this.installing.set(true);
      else if (evt.type === 'VERSION_INSTALLATION_FAILED') this.installing.set(false);
      else if (evt.type === 'VERSION_READY') document.location.reload();
    });

    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }
}
