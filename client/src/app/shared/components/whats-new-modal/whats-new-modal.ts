import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { icons } from '../../icons';
import { SwUpdate } from '@angular/service-worker';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { UsersApiService } from '../../../core/services/api/users-api.service';
import { SERVER_SINCE, ServerVersionService } from '../../../core/services/server-version.service';
import { compareVersions, releaseOf } from '../../../core/utils/semver';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';
import { ModalComponent } from '../modal';

export interface WhatsNewSlide {
  version: string;
  title: string;
  image: string | null;
  alt: string;
  body: string;
}

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

/** Versions with notes to show, oldest first: the latest three after `seen` up to `current`. */
export function versionsToShow(index: string[], seen: string, current: string): string[] {
  const [last, now] = [releaseOf(seen), releaseOf(current)];
  return index
    .filter((v) => compareVersions(v, now) <= 0)
    .sort((a, b) => compareVersions(b, a))
    .filter((v) => compareVersions(v, last) > 0)
    .slice(0, MAX_VERSIONS)
    .reverse();
}

/** Text of `url`, or null when missing; a server's SPA fallback answers a missing file with index.html. */
async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url);
  return res.ok && !res.headers.get('content-type')?.includes('html') ? res.text() : null;
}

/** Carousel of `public/whats-new/<version>/<lang>.md` for the versions listed in `whats-new/index.json`, shown everywhere but TV, once per account. */
@Component({
  selector: 'app-whats-new-modal',
  imports: [ModalComponent, TranslatePipe, MarkdownPipe, ModalHeaderComponent, ModalFooterComponent, LucideDynamicIcon],
  templateUrl: './whats-new-modal.html',
})
export class WhatsNewModalComponent {
  protected readonly icons = icons;

  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly api = inject(UsersApiService);
  private readonly versions = inject(ServerVersionService);
  private readonly swUpdate = inject(SwUpdate, { optional: true });
  private readonly dialog = viewChild<string, ElementRef<HTMLDialogElement>>('dialog', { read: ElementRef });
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  readonly slides = signal<WhatsNewSlide[]>([]);
  readonly index = signal(0);
  readonly version = computed(() => this.slides()[this.index()]?.version ?? environment.version);

  private checkedFor: number | null = null;

  constructor() {
    effect(() => {
      const user = this.auth.user();
      if (!user || user.id === this.checkedFor || !this.versions.supports(SERVER_SINCE.whatsNew)) return;
      this.checkedFor = user.id;
      untracked(() => void this.showIfNew(user.id));
    });
  }

  private async showIfNew(id: number): Promise<void> {
    const current = environment.version;
    // The stored profile can predate notes seen on another device.
    await this.auth.refreshUser();
    const user = this.auth.user();
    const seen = user?.whatsNewSeen ?? null;
    if (user?.id !== id || (seen !== null && compareVersions(releaseOf(seen), releaseOf(current)) >= 0)) return;
    if (await this.updatePending()) return;
    // An account without a value, or with the popup off, only records the version.
    if (seen === null || user.whatsNewEnabled === false) return this.markSeen(id, current);
    const root = new URL('whats-new/', document.baseURI).href;
    const lang = this.translate.currentLang() || 'en';
    const slides: WhatsNewSlide[] = [];
    try {
      const index = JSON.parse((await fetchText(`${root}index.json`)) ?? '[]') as string[];
      for (const version of versionsToShow(index, seen, current)) {
        const base = `${root}${version}/`;
        let md: string | null = null;
        for (const l of new Set([lang, 'en'])) if ((md = await fetchText(`${base}${l}.md`))) break;
        // A listed version without notes is a broken deploy: keep it unseen for the fixed one.
        if (!md) return;
        slides.push(...parseWhatsNew(md, base).map((s) => ({ ...s, version })));
      }
    } catch {
      return; // Offline: try again on the next launch.
    }
    this.markSeen(id, current);
    if (!slides.length) return;
    this.slides.set(slides);
    this.dialog()?.nativeElement.showModal();
  }

  private markSeen(id: number, version: string): void {
    this.api.update(id, { whatsNewSeen: version }, { skipErrorToast: true }).then(
      () => this.auth.patchUser({ whatsNewSeen: version }),
      () => undefined,
    );
  }

  /** True when the PWA is about to reload into a newer version: its own notes will show then. */
  private async updatePending(): Promise<boolean> {
    if (!this.swUpdate?.isEnabled) return false;
    // A page with no controlling worker yet waits for one: give up after a few seconds.
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000));
    return Promise.race([this.swUpdate.checkForUpdate().catch(() => false), timeout]);
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
