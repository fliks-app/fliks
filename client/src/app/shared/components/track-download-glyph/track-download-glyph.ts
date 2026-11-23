import { Component, computed, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import { MusicDownloadsService } from '../../../core/services/music-downloads.service';

/** A track's place on the device: a ring while it downloads, a primary glyph once it is there, nothing otherwise. */
@Component({
  selector: 'app-track-download-glyph',
  imports: [TranslatePipe, LucideDynamicIcon],
  templateUrl: './track-download-glyph.html',
  host: { class: 'contents' },
})
export class TrackDownloadGlyphComponent {
  protected readonly icons = icons;

  readonly itemId = input.required<number>();
  private readonly downloads = inject(MusicDownloadsService);
  protected readonly task = computed(() => this.downloads.tracks().get(this.itemId()) ?? null);
}
