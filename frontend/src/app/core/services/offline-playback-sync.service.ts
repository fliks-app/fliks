import { Injectable, inject } from '@angular/core';
import { StreamingApiService } from './api/streaming-api.service';
import { NetworkService } from './network.service';

interface PendingUpdate {
  mediaId: number;
  mediaFileId: number;
  episodeId?: number;
  positionSeconds: number;
  durationSeconds: number;
}

const STORAGE_KEY = 'fliks.offline.pendingPlayback';

@Injectable({ providedIn: 'root' })
export class OfflinePlaybackSyncService {
  private readonly streamingApi = inject(StreamingApiService);
  private readonly network = inject(NetworkService);

  constructor() {
    window.addEventListener('online', () => this.flush());
  }

  queue(update: PendingUpdate) {
    const pending = this.loadPending();
    // Replace existing entry for same media+episode (keep latest position)
    const idx = pending.findIndex(
      (p) => p.mediaId === update.mediaId && p.episodeId === update.episodeId,
    );
    if (idx >= 0) pending[idx] = update;
    else pending.push(update);
    this.savePending(pending);

    if (this.network.isOnline()) {
      void this.flush();
    }
  }

  async flush() {
    const pending = this.loadPending();
    if (!pending.length) return;

    const remaining: PendingUpdate[] = [];
    for (const update of pending) {
      try {
        await this.streamingApi.updatePlaybackState(update.mediaId, {
          positionSeconds: update.positionSeconds,
          durationSeconds: update.durationSeconds,
          mediaFileId: update.mediaFileId,
          episodeId: update.episodeId,
        });
      } catch {
        remaining.push(update);
      }
    }
    this.savePending(remaining);
  }

  private loadPending(): PendingUpdate[] {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      return [];
    }
  }

  private savePending(pending: PendingUpdate[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  }
}
