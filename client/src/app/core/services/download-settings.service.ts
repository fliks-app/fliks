import { Injectable, effect, inject, signal } from '@angular/core';
import { DownloadNotificationService } from './download-notification.service';

const STORAGE_KEY = 'downloads.maxConcurrent';

/** Past a handful, concurrent HLS transfers just share the same pipe more ways
 *  and every one of them lands later. */
export const MAX_CONCURRENT_CHOICES = [1, 2, 3, 4, 5] as const;
const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Per-device download preferences.
 *
 * Not scoped to an account: how many transfers this phone should run at once
 * is a property of the phone and its connection, not of who is signed in.
 */
@Injectable({ providedIn: 'root' })
export class DownloadSettingsService {
  private readonly notif = inject(DownloadNotificationService);

  /** Transfers allowed to run at the same time. */
  readonly maxConcurrent = signal(loadMaxConcurrent());

  constructor() {
    // Fires on construction too, so the native queue is capped before the first
    // download rather than after the setting is next touched.
    effect(() => this.notif.setMaxConcurrentDownloads(this.maxConcurrent()));
  }

  setMaxConcurrent(value: number): void {
    const clamped = clamp(value);
    this.maxConcurrent.set(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      /* quota / private mode — the in-memory value still applies this session */
    }
  }
}

function clamp(value: number): number {
  const first = MAX_CONCURRENT_CHOICES[0];
  const last = MAX_CONCURRENT_CHOICES[MAX_CONCURRENT_CHOICES.length - 1];
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT;
  return Math.min(last, Math.max(first, Math.round(value)));
}

function loadMaxConcurrent(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_MAX_CONCURRENT : clamp(Number(raw));
  } catch {
    return DEFAULT_MAX_CONCURRENT;
  }
}
