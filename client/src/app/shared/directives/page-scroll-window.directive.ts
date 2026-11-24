import { CdkVirtualScrollableWindow, VIRTUAL_SCROLLABLE } from '@angular/cdk/scrolling';
import { Directive, forwardRef, input, Signal } from '@angular/core';
import { filter, Observable } from 'rxjs';

/** The window scroller of a virtual grid on a cached route: a parked page stops re-ranging off other pages' scrolling. */
@Directive({
  selector: 'cdk-virtual-scroll-viewport[pageScrollWindow]',
  providers: [{ provide: VIRTUAL_SCROLLABLE, useExisting: forwardRef(() => PageScrollWindowDirective) }],
})
export class PageScrollWindowDirective extends CdkVirtualScrollableWindow {
  /** True while the grid must not follow the window (a parked page), read per event: a detached view never gets its inputs refreshed. */
  readonly pageScrollWindow = input.required<Signal<boolean>>();

  override elementScrolled(): Observable<Event> {
    return super.elementScrolled().pipe(filter(() => !this.pageScrollWindow()()));
  }
}
