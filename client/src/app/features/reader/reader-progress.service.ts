import { Injectable, inject } from '@angular/core';
import { ReaderApiService, type ReaderProgress, type ReaderTarget } from './reader-api.service';

/** A page turn fires several position events; one save per pause is enough. */
export const PROGRESS_DEBOUNCE_MS = 2000;

/** Debounces what the navigator reports into one save per pause, flushed when the reader closes. */
@Injectable()
export class ReaderProgressService {
  private readonly api = inject(ReaderApiService);
  private pending: { target: ReaderTarget; progress: ReaderProgress } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();

  report(target: ReaderTarget, progress: ReaderProgress): void {
    this.pending = { target, progress };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), PROGRESS_DEBOUNCE_MS);
  }

  /** Hands the latest report to a request that survives the page going away. */
  flushOnExit(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const send = this.pending;
    this.pending = null;
    if (send) this.api.saveProgressOnExit(send.target, send.progress);
  }

  /** Sends the latest report now; a failed save is dropped, the next position retries. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const send = this.pending;
    this.pending = null;
    if (!send) return;
    // Chained so a late flush cannot overtake an earlier request and move the position back.
    this.inflight = this.inflight.then(async () => {
      try {
        await this.api.saveProgress(send.target, send.progress);
      } catch {
        // Best effort: reading goes on without a server.
      }
    });
    return this.inflight;
  }
}
