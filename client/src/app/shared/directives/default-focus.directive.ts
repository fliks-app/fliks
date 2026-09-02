import {
  Directive,
  ElementRef,
  OnDestroy,
  OnInit,
  afterNextRender,
  inject,
  input,
} from '@angular/core';
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import {
  DefaultFocusService,
  DefaultFocusTarget,
} from '../../core/services/default-focus.service';

/**
 * Declares a page's default-focus target. On arrival (fresh navigation or
 * back-nav re-attach) the {@link DefaultFocusService} focuses it — gated to
 * keyboard / TV so mouse and touch are untouched — and restores the previously
 * focused item on back-navigation. Drop it on any page's root container:
 *
 *   <div appDefaultFocus="a[data-home-focus^='library:']"
 *        focusKey="home" focusIdAttr="data-home-focus"> … </div>
 */
@Directive({ selector: '[appDefaultFocus]', standalone: true })
export class DefaultFocusDirective implements OnInit, OnDestroy {
  /** CSS selector (within host) of the first element to focus; '' → first focusable. */
  readonly appDefaultFocus = input<string>('');
  /** Focus-memory key for back-nav restore; '' → no restore. */
  readonly focusKey = input<string>('');
  /** Data-attribute identifying restorable items (reuses existing markers). */
  readonly focusIdAttr = input<string>('data-focus-id');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly svc = inject(DefaultFocusService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly reuseStrategy = inject(CachingReuseStrategy);
  private readonly subs = new Subscription();
  private readonly targetGetter = (): DefaultFocusTarget => this.target();

  constructor() {
    // Fresh navigation: the directive is created with the component, so the
    // next render is the arrival. A back-nav re-attach reuses the component
    // (no re-render), so attached$ below covers that case.
    afterNextRender(() => this.svc.applyOnArrival(this.target()));
  }

  ngOnInit(): void {
    // Let spatial-nav land here when nothing is focused (cold-load + first key).
    this.svc.register(this.targetGetter);
    this.subs.add(
      this.reuseStrategy.attached$
        // Resolved per event: a page reused across a param change is cached
        // under the params it last showed, not the ones it started on.
        .pipe(filter((key) => key === this.reuseStrategy.keyFor(this.route.snapshot)))
        .subscribe(() => this.svc.applyOnArrival(this.target())),
    );
    // Capture the focused item the instant a navigation starts (host still in
    // the DOM) so a later back-navigation can return to it.
    this.subs.add(
      this.router.events
        .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
        .subscribe(() => this.svc.saveFocus(this.target())),
    );
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.svc.unregister(this.targetGetter);
  }

  private target(): DefaultFocusTarget {
    return {
      host: this.host.nativeElement,
      selector: this.appDefaultFocus(),
      focusKey: this.focusKey(),
      focusIdAttr: this.focusIdAttr(),
    };
  }
}
