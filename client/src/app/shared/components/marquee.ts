import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, DestroyRef, afterNextRender, inject, input, signal, viewChild } from '@angular/core';

const GAP = 48;

/** One line of text that scrolls in a loop when it is wider than its box, its edges fading out. */
@Component({
  selector: 'app-marquee',
  host: { class: 'block min-w-0' },
  imports: [NgTemplateOutlet],
  templateUrl: './marquee.html',
  styleUrl: './marquee.css',
})
export class MarqueeComponent {
  readonly text = input.required<string>();
  /** Dimmed after the text on the same line, e.g. the artist after a track. */
  readonly secondary = input('');

  private readonly box = viewChild.required<ElementRef<HTMLElement>>('box');
  private readonly line = viewChild.required<ElementRef<HTMLElement>>('line');
  /** The text's own width, and whether it overflows its box. */
  protected readonly width = signal(0);
  protected readonly overflowing = signal(false);
  /** Gap between the end of the text and its repeat, in px. */
  protected readonly gap = GAP;

  constructor() {
    const observer = new ResizeObserver(() => {
      const width = this.line().nativeElement.offsetWidth;
      this.width.set(width);
      this.overflowing.set(width > this.box().nativeElement.clientWidth);
    });
    afterNextRender(() => {
      observer.observe(this.box().nativeElement);
      observer.observe(this.line().nativeElement);
    });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}
