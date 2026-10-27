import { ChangeDetectionStrategy, Component, ElementRef, effect, input, viewChild } from '@angular/core';

export interface BlockingOverlayAction {
  label: string;
  run: () => void;
}

/** Modal that blocks the page while something is in progress; the caller drives `open` and passes translated text. A top-layer dialog also covers a fullscreen element. */
@Component({
  selector: 'app-blocking-overlay',
  templateUrl: './blocking-overlay.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlockingOverlayComponent {
  readonly open = input.required<boolean>();
  readonly message = input.required<string>();
  /** 0-100 for a determinate bar; omitted shows a spinner. */
  readonly progress = input<number | null>(null);
  readonly actions = input<BlockingOverlayAction[]>([]);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.open()) {
        if (!el.open) el.showModal();
      } else el.close();
    });
  }
}
