import { Component, computed, input, output, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCircleAlert } from '@lucide/angular';
import type { PlaybackError } from '../../../core/services/playback-engine/playback-error';

/** The failure panel for any playback surface: on-demand and live alike. */
@Component({
  selector: 'app-player-error-overlay',
  imports: [TranslatePipe, LucideCircleAlert],
  templateUrl: './player-error-overlay.html',
})
export class PlayerErrorOverlayComponent {
  readonly error = input<PlaybackError | null>(null);
  /** Pre-formatted dump; the copy button is hidden when it is empty. */
  readonly diagnostics = input('');
  readonly canRetry = input(true);

  readonly retry = output<void>();
  readonly back = output<void>();

  readonly copied = signal(false);

  readonly hasDetails = computed(() => {
    const err = this.error();
    return !!err && (err.code != null || !!err.data?.length || !!err.variant || !!err.message);
  });

  async copy(): Promise<void> {
    const text = this.diagnostics();
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Clipboard denied: the dump stays readable in the details block.
    }
  }
}
