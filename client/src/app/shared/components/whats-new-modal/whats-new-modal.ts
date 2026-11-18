import { Component, ElementRef, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideRocket } from '@lucide/angular';
import { environment } from '../../../../environments/environment';
import { DeviceService } from '../../../core/services/device.service';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

export interface WhatsNewSlide {
  title: string;
  image: string | null;
  alt: string;
  body: string;
}

const SEEN_KEY = 'fliks.whatsNewSeen';

/** One slide per `## Title` section; its first image becomes the slide picture, resolved against `base`. */
export function parseWhatsNew(md: string, base: string): WhatsNewSlide[] {
  return md
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [title, ...rest] = section.split('\n');
      let body = rest.join('\n');
      const img = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(body);
      if (img) body = body.replace(img[0], '');
      return {
        title: title.trim(),
        image: img ? new URL(img[2], base).href : null,
        alt: img?.[1] ?? '',
        body: body.trim(),
      };
    });
}

/** Carousel of `public/whats-new/<version>/<lang>.md`, shown once per version on desktop and web. */
@Component({
  selector: 'app-whats-new-modal',
  imports: [TranslatePipe, MarkdownPipe, LucideRocket, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './whats-new-modal.html',
})
export class WhatsNewModalComponent {
  private readonly translate = inject(TranslateService);
  private readonly device = inject(DeviceService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  readonly version = environment.version;
  readonly slides = signal<WhatsNewSlide[]>([]);
  readonly index = signal(0);

  constructor() {
    afterNextRender(() => void this.showIfNew());
  }

  private async showIfNew(): Promise<void> {
    if (!this.device.isDesktop() || localStorage.getItem(SEEN_KEY) === this.version) return;
    const base = new URL(`whats-new/${this.version}/`, document.baseURI).href;
    const lang = this.translate.currentLang() || 'en';
    let md: string | null = null;
    try {
      for (const l of new Set([lang, 'en'])) {
        const res = await fetch(`${base}${l}.md`);
        // A server's SPA fallback answers a missing file with index.html.
        if (res.ok && !res.headers.get('content-type')?.includes('html')) {
          md = await res.text();
          break;
        }
      }
    } catch {
      return; // Offline: try again on the next launch.
    }
    localStorage.setItem(SEEN_KEY, this.version);
    const slides = md ? parseWhatsNew(md, base) : [];
    if (!slides.length) return;
    this.slides.set(slides);
    this.dialog()?.nativeElement.showModal();
  }

  go(i: number): void {
    const track = this.track()?.nativeElement;
    if (!track) return;
    const to = Math.max(0, Math.min(i, this.slides().length - 1));
    track.scrollTo({ left: to * track.clientWidth });
  }

  onScroll(track: HTMLElement): void {
    this.index.set(Math.round(track.scrollLeft / track.clientWidth));
  }

  next(): void {
    if (this.index() === this.slides().length - 1) this.dialog()?.nativeElement.close();
    else this.go(this.index() + 1);
  }
}
