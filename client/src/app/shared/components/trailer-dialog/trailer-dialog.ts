import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideX } from '@lucide/angular';
import { openTrailerExternally, trailerPlaysInline } from '../../utils/trailer.util';

/** Plays a YouTube trailer in a dialog, or hands it to the system where the embed cannot run. */
@Component({
  selector: 'app-trailer-dialog',
  imports: [TranslatePipe, LucideX],
  templateUrl: './trailer-dialog.html',
})
export class TrailerDialogComponent {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Set only while the dialog is open, so playback stops when it closes. */
  readonly embedUrl = signal<SafeResourceUrl | null>(null);

  open(key: string): void {
    if (!trailerPlaysInline) {
      openTrailerExternally(key);
      return;
    }
    this.embedUrl.set(
      this.sanitizer.bypassSecurityTrustResourceUrl(`https://www.youtube.com/embed/${key}?autoplay=1`),
    );
    this.dialog()?.nativeElement.showModal();
  }
}
