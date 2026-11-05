import { Component, OnDestroy, OnInit, Type, forwardRef, inject } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { BackgroundService } from '../../core/services/background.service';
import { NavbarService } from '../../core/services/navbar.service';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { PREVIEW_HOST, type PreviewHost, type PreviewSeed } from './preview-host';

/** The route shell of every add preview: reads the route and the card's seed, owns the hero chrome and
 *  renders the kind's body (`data.page`). */
@Component({
  selector: 'app-tmdb-preview',
  imports: [NgComponentOutlet, DefaultFocusDirective, TvSectionDirective],
  templateUrl: './tmdb-preview.html',
  providers: [{ provide: PREVIEW_HOST, useExisting: forwardRef(() => TmdbPreviewComponent) }],
})
export class TmdbPreviewComponent implements PreviewHost, OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly navbar = inject(NavbarService);
  private readonly backgroundService = inject(BackgroundService);

  /** The body of the kind, loaded by the route's resolver before this component activates. */
  protected readonly page: Type<unknown> | null = this.route.snapshot.data['page'] ?? null;

  /** Provider from route param (e.g. /add/movie/tvdb/123) or default to 'tmdb' */
  protected readonly provider = this.route.snapshot.paramMap.get('provider') ?? 'tmdb';

  /** `:externalId` on the provider-aware routes, `:tmdbId` on the TMDB-only ones. */
  protected readonly externalId =
    this.route.snapshot.paramMap.get('externalId') ?? this.route.snapshot.paramMap.get('tmdbId') ?? '';

  /** Read before the first render, so the poster the card stamped has its pair. */
  protected readonly seed: PreviewSeed | null = (() => {
    const seed = (history.state as { preview?: PreviewSeed } | null)?.preview;
    return seed?.externalId === this.externalId ? seed : null;
  })();

  ngOnInit() {
    // Hero chrome from the first frame, so the skeleton sits where the page will.
    this.navbar.enterHeroPage(this.seed?.title ?? '');
  }

  ngOnDestroy() {
    this.backgroundService.release(this);
    this.navbar.leaveHeroPage();
  }

  setTitle(title: string, logoUrl?: string | null) {
    this.navbar.enterHeroPage(title, logoUrl);
  }

  setBackground(url: string | null, opts?: { blur?: boolean }) {
    this.backgroundService.set(this, url, opts);
  }
}
