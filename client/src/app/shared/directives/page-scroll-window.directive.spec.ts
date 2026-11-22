import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CdkFixedSizeVirtualScroll, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { describe, expect, it, vi } from 'vitest';
import { PageScrollWindowDirective } from './page-scroll-window.directive';

@Component({
  imports: [CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, PageScrollWindowDirective],
  template: `<cdk-virtual-scroll-viewport [pageScrollWindow]="detached" itemSize="10" />`,
})
class HostComponent {
  readonly detached = signal(false);
}

describe('PageScrollWindowDirective', () => {
  it('stops forwarding the document scroll once the page detaches, with no change detection', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const directive = fixture.debugElement
      .query(By.directive(PageScrollWindowDirective))
      .injector.get(PageScrollWindowDirective);
    const seen = vi.fn();
    const sub = directive.elementScrolled().subscribe(seen);

    document.dispatchEvent(new Event('scroll'));
    expect(seen).toHaveBeenCalledTimes(1);

    fixture.componentInstance.detached.set(true);
    document.dispatchEvent(new Event('scroll'));
    expect(seen).toHaveBeenCalledTimes(1);

    fixture.componentInstance.detached.set(false);
    document.dispatchEvent(new Event('scroll'));
    expect(seen).toHaveBeenCalledTimes(2);
    sub.unsubscribe();
  });
});
