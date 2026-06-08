import { Injectable, computed, inject, signal } from '@angular/core';
import { SettingsApiService } from './api/settings-api.service';

/**
 * Lazily-cached read access to server-side application settings for surfaces
 * that need a flag but don't own the settings page. Loads `/api/settings` once
 * and exposes signals; call `refresh()` after a save to re-read.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly api = inject(SettingsApiService);
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
   * Hide burn-required (image-based) subtitles from the player / cast pickers
   * and the media-detail header. Defaults to `true` — burn-in is currently
   * non-functional, so a visible-but-unusable track is worse than hidden.
   */
  readonly hideBurnInSubtitles = computed(() => {
    const v = this.all()?.['subtitle_hide_burn_in'];
    return v == null ? true : v !== 'false';
  });
}
