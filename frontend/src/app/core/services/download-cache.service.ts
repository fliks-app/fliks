import { Injectable, signal } from '@angular/core';
import { DownloadTask } from './api/downloads-api.service';

const STORAGE_KEY = 'fliks.downloads.cache';

/**
 * Tracks device download progress (in-memory signals) and
 * persists task list for offline access (localStorage).
 */
@Injectable({ providedIn: 'root' })
export class DownloadCacheService {
  /** Active device downloads with progress % */
  readonly activeDownloads = signal<Map<number, number>>(new Map());

  markDownloading(taskId: number) {
    this.activeDownloads.update((m) => new Map(m).set(taskId, 0));
  }

  updateProgress(taskId: number, percent: number) {
    this.activeDownloads.update((m) => new Map(m).set(taskId, percent));
  }

  markDone(taskId: number) {
    this.activeDownloads.update((m) => {
      const next = new Map(m);
      next.delete(taskId);
      return next;
    });
  }

  isDownloading(taskId: number): boolean {
    return this.activeDownloads().has(taskId);
  }

  getProgress(taskId: number): number {
    return this.activeDownloads().get(taskId) ?? 0;
  }

  /** Persist task list for offline recovery */
  save(tasks: DownloadTask[]) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
      // quota exceeded
    }
  }

  /** Load cached task list (for offline) */
  load(): DownloadTask[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  remove(taskId: number) {
    const tasks = this.load().filter((t) => t.id !== taskId);
    this.save(tasks);
  }
}
