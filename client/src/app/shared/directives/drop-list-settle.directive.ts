import { ChangeDetectorRef, Directive, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CdkDropList } from '@angular/cdk/drag-drop';

/** Renders a drop before the next paint, where zoneless change detection would paint the old order
 *  for a frame first. Import it wherever `cdkDropList` is used. */
@Directive({ selector: '[cdkDropList]' })
export class DropListSettleDirective {
  constructor() {
    const cdr = inject(ChangeDetectorRef);
    inject(CdkDropList)
      .dropped.pipe(takeUntilDestroyed())
      .subscribe(() => queueMicrotask(() => cdr.detectChanges()));
  }
}
