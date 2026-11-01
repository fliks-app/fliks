import { Injectable, inject } from '@angular/core';
import { ReaderApiService, type ReaderProgress } from './reader-api.service';

/** A page turn fires several position events; one save per pause is enough. */
export const PROGRESS_DEBOUNCE_MS = 2000;

/** Debounces what the navigator reports into one save per pause, flushed when the reader closes. */
@Injectable()
export class ReaderProgressService {
  private readonly api = inject(ReaderApiService);
  private pending: { itemId: number; progress: ReaderProgress } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  report(itemId: number, progress: ReaderProgress): void {
    this.pending = { itemId, progress };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), PROGRESS_DEBOUNCE_MS);
  }

  /** Sends the latest report now; a failed save is dropped, the next position retries. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const send = this.pending;
    this.pending = null;
    if (!send) return;
    try {
      await this.api.saveProgress(send.itemId, send.progress);
    } catch {
      // Best effort: reading goes on without a server.
    }
  }
}
