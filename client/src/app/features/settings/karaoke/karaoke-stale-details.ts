import { Component, ElementRef, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { KaraokeApiService } from '../../../core/services/api/karaoke-api.service';
import { failureText } from '../../../core/services/karaoke/karaoke-failure';
import type { KaraokeFailure, KaraokeModel, KaraokeStaleTrack } from '../../../core/services/api/karaoke.models';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { ModalFooterComponent } from '../../../shared/components/modal-footer';
import { ModalHeaderComponent } from '../../../shared/components/modal-header';

/** The tracks the re-sync would redo, with the outcome of their last attempt; the server pages them. */
@Component({
  selector: 'app-karaoke-stale-details',
  imports: [TranslatePipe, DatePipe, ModalHeaderComponent, ModalFooterComponent],
  templateUrl: './karaoke-stale-details.html',
})
export class KaraokeStaleDetailsComponent {
  private readonly api = inject(KaraokeApiService);
  private readonly translate = inject(TranslateService);
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private observer?: IntersectionObserver;
  private loading = false;

  readonly models = input.required<KaraokeModel[]>();
  readonly closed = output<void>();

  protected readonly items = signal<KaraokeStaleTrack[]>([]);
  protected readonly total = signal(0);
  protected readonly loaded = signal(false);
  protected readonly minPercent = signal(0);

  constructor() {
    effect(() => this.dialog()?.nativeElement.showModal());
    effect((onCleanup) => {
      const el = this.sentinel()?.nativeElement;
      if (!el) return;
      this.observer = new IntersectionObserver(
        (seen) => {
          if (seen[0]?.isIntersecting) void this.loadMore();
        },
        { rootMargin: '300px' },
      );
      this.observer.observe(el);
      onCleanup(() => this.observer?.disconnect());
    });
  }

  protected get hasMore(): boolean {
    return this.items().length < this.total();
  }

  /** Fetches the next page; the sentinel calls it again while it stays in view. */
  async loadMore(): Promise<void> {
    if (this.loading || (this.loaded() && !this.hasMore)) return;
    this.loading = true;
    try {
      const page = await this.api.staleItems(this.items().length);
      this.total.set(page.total);
      this.minPercent.set(Math.round(page.minMatch * 100));
      this.items.update((cur) => [...cur, ...page.items]);
    } catch {
      this.total.set(this.items().length);
    } finally {
      this.loaded.set(true);
      this.loading = false;
    }
  }

  protected name(id: string): string {
    return this.models().find((m) => m.id === id)?.name ?? id;
  }

  protected byline(t: KaraokeStaleTrack): string {
    return [t.artist, t.album].filter(Boolean).join(' · ');
  }

  protected language(code: string | null): string {
    return code ? localizeLanguage(code, this.translate) : '';
  }

  protected failure(f: KaraokeFailure): string {
    return failureText(this.translate, f);
  }

  protected percent(matched: number | null): number {
    return Math.round((matched ?? 0) * 100);
  }
}
