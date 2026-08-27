import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslateModule } from '@ngx-translate/core';
import { ModalHeaderComponent } from '../modal-header';
import { VttCue, parseVtt } from '../../../core/services/playback-engine/subtitle-overlay.util';
import { formatTime } from '../../../core/utils/player.utils';
import { ModalFooterComponent } from '../modal-footer';

/** Read-only cue list. Reads the player's own WebVTT through the engine's
 *  parser, so it shows what would be rendered, tag sanitisation included. */
@Component({
  selector: 'app-subtitle-viewer-modal',
  imports: [ModalFooterComponent, TranslateModule, ModalHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitle-viewer-modal.html',
})
export class SubtitleViewerModalComponent {
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly http = inject(HttpClient);

  readonly title = signal('');
  readonly cues = signal<VttCue[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);

  readonly formatTime = formatTime;

  async open(title: string, url: string): Promise<void> {
    this.title.set(title);
    this.cues.set([]);
    this.failed.set(false);
    this.loading.set(true);
    this.dialog()?.nativeElement.showModal();
    try {
      const raw = await firstValueFrom(this.http.get(url, { responseType: 'text' }));
      this.cues.set(parseVtt(raw));
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  close(): void {
    this.dialog()?.nativeElement.close();
  }
}
