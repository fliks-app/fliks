import { describe, expect, it } from 'vitest';
import { renderRowsForOffset } from './restore-virtual-rows';

describe('renderRowsForOffset', () => {
  it('lays the viewport out at the target offset and keeps it', () => {
    const order: string[] = [];
    const applied: number[] = [];
    let scrollY = 4200;
    const scroller = {
      get scrollY() { return scrollY; },
      scrollTo: (o: ScrollToOptions) => {
        scrollY = o.top ?? 0;
        applied.push(scrollY);
      },
    };
    const viewport = { checkViewportSize: () => order.push(`measure@${scrollY}`) };

    renderRowsForOffset(viewport, 27274, () => order.push(`flush@${scrollY}`), scroller);

    // Both happen while the offset is the one the rows are needed for: CDK reads
    // it to choose the range, and the flush is what renders that range.
    expect(order).toEqual(['measure@27274', 'flush@27274']);
    // The offset stays: handing it back let CDK re-pick its range from a scroll
    // of 0 on the next frame, dropping the rows this call just rendered.
    expect(applied).toEqual([27274]);
    expect(scrollY).toBe(27274);
  });
});
