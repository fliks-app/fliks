import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { restoreOpenerFocus } from '../../core/services/focusable.constants';
import { BottomSheetComponent } from './bottom-sheet';
import { DropdownToggleDirective } from '../directives/dropdown-toggle.directive';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';

type Placement = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start';

/** Form-factor-aware menu: DaisyUI `.dropdown` on desktop, BottomSheetComponent on touch / TV; the `trigger` child is projected first.
 *  Both slots sit in <ng-template> + *ngTemplateOutlet because <ng-content> inside @if blocks doesn't project reliably. */
@Component({
  selector: 'app-dropdown-menu',
  standalone: true,
  imports: [NgTemplateOutlet, BottomSheetComponent, DropdownToggleDirective],
  templateUrl: './dropdown-menu.html',
})
export class DropdownMenuComponent {
  readonly placement = input<Placement>('bottom-end');
  /** Title for the sheet variant (touch / TV). The desktop dropdown ignores it. */
  readonly heading = input('');
  /** Height cap on the panel; an upward-opening panel near the page bottom needs a tighter one to keep its first options on screen. */
  readonly maxHeight = input('max-h-[70vh]');

  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);

  readonly useDropdown = computed(() => !this.tv.isTv() && !this.device.isTouch());
  protected readonly open = signal(false);

  /** The <app-bottom-sheet> (touch/TV), reparented under <html> so its `position: fixed` escapes the drawer's stacking context. */
  private readonly sheet = viewChild('sheet', { read: ElementRef });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private wasOpen = false;
  /** The sheet host once it's been moved under <html> (see below). */
  private reparentedSheet: HTMLElement | null = null;

  constructor() {
    if (typeof document === 'undefined') return;
    effect(() => {
      const ref = this.sheet();
      if (!ref || this.useDropdown()) return;
      queueMicrotask(() => {
        this.reparentedSheet = ref.nativeElement;
        document.documentElement.appendChild(ref.nativeElement);
      });
    });
    // The reparented sheet is outside Angular's DOM ownership; detach it so a mid-close teardown doesn't orphan its click-blocking backdrop.
    inject(DestroyRef).onDestroy(() => this.reparentedSheet?.remove());
    // The sheet branch skips DropdownToggleDirective, so refocus the trigger on close for parity with the dropdown.
    effect(() => {
      const open = this.open();
      const justClosed = this.wasOpen && !open;
      this.wasOpen = open;
      if (!justClosed || this.useDropdown()) return;
      queueMicrotask(() => {
        restoreOpenerFocus(
          this.host.nativeElement.querySelector<HTMLElement>('[trigger]'),
        );
      });
    });
  }

  protected readonly dropdownClasses = computed(() => {
    const p = this.placement();
    const cls: string[] = [];
    if (p.endsWith('end')) cls.push('dropdown-end');
    if (p.startsWith('top')) cls.push('dropdown-top');
    return cls.join(' ');
  });

  /** Closes on a click on an `<a>` / `<button>` inside the sheet, as the desktop directive does; padding clicks are ignored. */
  protected onItemsClick(event: Event) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button')) {
      this.open.set(false);
    }
  }
}
