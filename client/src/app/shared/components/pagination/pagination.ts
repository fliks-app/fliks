import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { LucideChevronLeft, LucideChevronRight } from '@lucide/angular';

type Slot = number | 'ellipsis';

@Component({
  selector: 'app-pagination',
  standalone: true,
  imports: [TranslateModule, LucideChevronLeft, LucideChevronRight],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pagination.html',
  host: { class: 'block' },
})
export class PaginationComponent {
  /** 1-indexed current page. */
  readonly current = input.required<number>();
  /** Total number of pages (≥ 1). */
  readonly total = input.required<number>();
  /** Pages to show on each side of the current page. Default 1 → 7 slots max. */
  readonly siblings = input<number>(1);
  /** When true, prev/next render as icon-only chevrons (compact). */
  readonly compact = input<boolean>(false);

  readonly pageChange = output<number>();

  readonly slots = computed<Slot[]>(() => {
    const total = this.total();
    const current = this.current();
    const siblings = this.siblings();

    const totalSlots = siblings * 2 + 5;
    if (total <= totalSlots) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    const leftSibling = Math.max(current - siblings, 1);
    const rightSibling = Math.min(current + siblings, total);
    const showLeftDots = leftSibling > 2;
    const showRightDots = rightSibling < total - 1;
    const edgeRun = 3 + 2 * siblings;

    if (!showLeftDots && showRightDots) {
      return [...this.range(1, edgeRun), 'ellipsis', total];
    }
    if (showLeftDots && !showRightDots) {
      return [1, 'ellipsis', ...this.range(total - edgeRun + 1, total)];
    }
    return [1, 'ellipsis', ...this.range(leftSibling, rightSibling), 'ellipsis', total];
  });

  goTo(page: number) {
    const total = this.total();
    if (page < 1 || page > total || page === this.current()) return;
    this.pageChange.emit(page);
  }

  private range(start: number, end: number): number[] {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
}
