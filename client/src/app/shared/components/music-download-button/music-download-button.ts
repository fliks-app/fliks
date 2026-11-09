import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideCircleArrowDown, LucideDownload } from '@lucide/angular';
import type { MusicTrackRequest } from '../../../core/services/audio-player/music-queue';
import { MusicDownloadsService } from '../../../core/services/music-downloads.service';

/** Keeps the tracks of an album, a playlist or an artist on the device, or removes them once they all are. */
@Component({
  selector: 'app-music-download-button',
  imports: [TranslatePipe, LucideCircleArrowDown, LucideDownload],
  templateUrl: './music-download-button.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicDownloadButtonComponent {
  /** Loads the tracks when the button is pressed. */
  readonly tracks = input.required<() => Promise<readonly MusicTrackRequest[]>>();
  /** The tracks already known: they give the state and let a full set be removed. A source loaded on demand leaves it out. */
  readonly itemIds = input<readonly number[]>([]);
  readonly showLabel = input(false);
  readonly buttonClass = input('btn btn-ghost btn-sm gap-2');
  readonly iconClass = input('h-4 w-4');

  protected readonly downloads = inject(MusicDownloadsService);
  protected readonly busy = signal(false);
  protected readonly state = computed(() => (this.itemIds().length ? this.downloads.state(this.itemIds()) : 'none'));
  protected readonly progress = computed(() => this.downloads.progress(this.itemIds()));
  protected readonly label = computed(() => (this.state() === 'all' ? 'downloads.remove_from_device' : 'downloads.download'));

  protected async press(): Promise<void> {
    this.busy.set(true);
    try {
      if (this.state() === 'all') await this.downloads.remove(this.itemIds());
      else await this.downloads.download(await this.tracks()());
    } catch {
      // The global interceptor toasts the failure.
    } finally {
      this.busy.set(false);
    }
  }
}
