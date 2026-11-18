import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideRocket } from '@lucide/angular';
import { environment } from '../../../../environments/environment';
import { DeviceService } from '../../../core/services/device.service';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

export interface WhatsNewSlide {
  version: string;
  title: string;
  image: string | null;
  alt: string;
  body: string;
}

const SEEN_KEY = 'fliks.whatsNewSeen';
const MAX_VERSIONS = 3;

/** One slide per `## Title` section; its first image becomes the slide picture, resolved against `base`. */
export function parseWhatsNew(md: string, base: string): Omit<WhatsNewSlide, 'version'>[] {
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

/** Compares the numeric core of two versions; a pre-release suffix is ignored. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Versions with notes to show, newest first: those after `seen` up to `current`, or the newest one when nothing was seen. */
export function versionsToShow(index: string[], seen: string | null, current: string): string[] {
  const upToCurrent = index
    .filter((v) => compareVersions(v, current) <= 0)
    .sort((a, b) => compareVersions(b, a));
  if (seen === null) return upToCurrent.slice(0, 1);
  return upToCurrent.filter((v) => compareVersions(v, seen) > 0).slice(0, MAX_VERSIONS);
}

/** Text of `url`, or null when missing; a server's SPA fallback answers a missing file with index.html. */
async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url);
  return res.ok && !res.headers.get('content-type')?.includes('html') ? res.text() : null;
}

/** Carousel of `public/whats-new/<version>/<lang>.md` for the versions listed in `whats-new/index.json`, shown on desktop and web. */
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

  readonly slides = signal<WhatsNewSlide[]>([]);
  readonly index = signal(0);
  readonly version = computed(() => this.slides()[this.index()]?.version ?? environment.version);

  constructor() {
    afterNextRender(() => void this.showIfNew());
  }

  private async showIfNew(): Promise<void> {
    const current = environment.version;
    const seen = localStorage.getItem(SEEN_KEY);
    if (!this.device.isDesktop() || seen === current) return;
    const root = new URL('whats-new/', document.baseURI).href;
    const lang = this.translate.currentLang() || 'en';
    const slides: WhatsNewSlide[] = [];
    try {
      const index = JSON.parse((await fetchText(`${root}index.json`)) ?? '[]') as string[];
      for (const version of versionsToShow(index, seen, current)) {
        const base = `${root}${version}/`;
        let md: string | null = null;
        for (const l of new Set([lang, 'en'])) if ((md = await fetchText(`${base}${l}.md`))) break;
        if (md) slides.push(...parseWhatsNew(md, base).map((s) => ({ ...s, version })));
      }
    } catch {
      return; // Offline: try again on the next launch.
    }
    localStorage.setItem(SEEN_KEY, current);
    if (!slides.length) return;
    this.slides.set(slides);
    this.dialog()?.nativeElement.showModal();
  }

  /** True on the first slide of a version after another one: the dots leave a gap there. */
  startsGroup(i: number): boolean {
    return i > 0 && this.slides()[i].version !== this.slides()[i - 1].version;
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
