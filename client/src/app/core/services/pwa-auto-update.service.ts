import { Injectable, inject, DestroyRef } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/** Reloads the PWA unconditionally when the service worker has a new version ready: hashed lazy chunks of the old shell would 404 (`ChunkLoadError`).
 * A full reload, not `activateUpdate()`, since the loaded JS keeps the old chunk hashes; web builds only. */
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
