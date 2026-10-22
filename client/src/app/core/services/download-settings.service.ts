import { Injectable, effect, inject, signal } from '@angular/core';
import { DownloadNotificationService } from './download-notification.service';

const STORAGE_KEY = 'downloads.maxConcurrent';

/** Past a handful, concurrent HLS transfers just share the same pipe more ways
 *  and every one of them lands later. */
export const MAX_CONCURRENT_CHOICES = [1, 2, 3, 4, 5] as const;
const DEFAULT_MAX_CONCURRENT = 3;

const QUALITY_KEY = 'downloads.defaultQuality';
const WIFI_ONLY_KEY = 'downloads.wifiOnly';
const AUTO_CAP_KEY = 'downloads.autoCapGb';

/** Empty means each file's best rung; the others are the engine's ladder keys, and a file without one falls to the nearest lower rung. */
export const DEFAULT_QUALITY_CHOICES = ['', 'original', '2160p', '1080p', '720p', '480p', '360p'] as const;

/** Per-device download preferences, not scoped to an account: concurrency belongs to the phone and its connection. */
@Injectable({ providedIn: 'root' })
export class DownloadSettingsService {
  private readonly notif = inject(DownloadNotificationService);

  /** Transfers allowed to run at the same time. */
  readonly maxConcurrent = signal(loadMaxConcurrent());

  /** Rung pre-selected in the quality picker and used by auto downloads; '' = best available. */
  readonly defaultQuality = signal(read(QUALITY_KEY, (r) => (DEFAULT_QUALITY_CHOICES as readonly string[]).includes(r) ? r : '', ''));
  /** Native only: queue downloads until an unmetered network is available. */
  readonly wifiOnly = signal(read(WIFI_ONLY_KEY, (r) => r === 'true', false));
  /** GB that auto downloads may occupy; 0 = no cap. */
  readonly autoCapGb = signal(read(AUTO_CAP_KEY, (r) => Math.max(0, Math.floor(Number(r)) || 0), 0));

  constructor() {
    // Fires on construction too, so the native queue is capped before the first
    // download rather than after the setting is next touched.
    effect(() => this.notif.setMaxConcurrentDownloads(this.maxConcurrent()));
    effect(() => this.notif.setWifiOnly(this.wifiOnly()));
  }

  setDefaultQuality(value: string): void {
    this.defaultQuality.set(value);
    write(QUALITY_KEY, value);
  }

  setWifiOnly(value: boolean): void {
    this.wifiOnly.set(value);
    write(WIFI_ONLY_KEY, String(value));
  }

  setAutoCapGb(value: number | string): void {
    const gb = Math.max(0, Math.floor(Number(value)) || 0);
    this.autoCapGb.set(gb);
    write(AUTO_CAP_KEY, String(gb));
  }

  setMaxConcurrent(value: number | string): void {
    const clamped = clamp(value);
    this.maxConcurrent.set(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      /* quota / private mode — the in-memory value still applies this session */
    }
  }
}

function clamp(value: number | string): number {
  const first = MAX_CONCURRENT_CHOICES[0];
  const last = MAX_CONCURRENT_CHOICES[MAX_CONCURRENT_CHOICES.length - 1];
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT;
  return Math.min(last, Math.max(first, Math.round(n)));
}

function loadMaxConcurrent(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_MAX_CONCURRENT : clamp(Number(raw));
  } catch {
    return DEFAULT_MAX_CONCURRENT;
  }
}

function read<T>(key: string, parse: (raw: string) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* in-memory value still applies this session */
  }
}
