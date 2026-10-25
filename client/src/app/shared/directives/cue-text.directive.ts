import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { renderCueText } from '../../core/services/playback-engine/subtitle-overlay.util';

/** Renders subtitle cue text as DOM nodes (b/i/u/br only), never as parsed HTML. */
@Directive({ selector: '[appCueText]' })
export class CueTextDirective {
  readonly text = input.required<string>({ alias: 'appCueText' });
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => renderCueText(this.el, this.text()));
  }
}
