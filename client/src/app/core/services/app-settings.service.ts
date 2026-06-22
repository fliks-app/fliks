import { Injectable, computed, inject, signal } from '@angular/core';
import { SettingsApiService } from './api/settings-api.service';
import { PlayerSettingsService } from './player-settings.service';

/**
 * Lazily-cached read access to server-side application settings for surfaces
 * that need a flag but don't own the settings page. Loads `/api/settings` once
 * and exposes signals; call `refresh()` after a save to re-read.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly api = inject(SettingsApiService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly all = signal<Record<string, string | null> | null>(null);
  private loadPromise: Promise<Record<string, string | null>> | null = null;

  /** Load the settings once (no-op once cached). Safe to call repeatedly. */
  async ensureLoaded(): Promise<void> {
    if (this.all()) return;
    if (!this.loadPromise) {
      this.loadPromise = this.api.getAll().catch(() => ({}) as Record<string, string | null>);
    }
    this.all.set(await this.loadPromise);
  }

  /** Re-read from the server (e.g. after the settings page saves). */
  async refresh(): Promise<void> {
    this.loadPromise = this.api.getAll().catch(() => ({}) as Record<string, string | null>);
    this.all.set(await this.loadPromise);
  }

  /**
   * Hide image-based (PGS/VOBSUB) subtitles from the pickers and native player.
   * A per-device client preference (image subs can't render as text — they need
   * burn-in or OCR).
   */
  readonly hideBurnInSubtitles = computed(
    () => this.playerSettings.settings().hideImageSubtitles,
  );
}
