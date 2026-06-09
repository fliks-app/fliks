import {
  ChangeDetectionStrategy,
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
import { BottomSheetComponent } from './bottom-sheet';
import { DropdownToggleDirective } from '../directives/dropdown-toggle.directive';
import { DeviceService } from '../../core/services/device.service';
import { TvService } from '../../core/services/tv.service';

type Placement = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start';

/**
 * Form-factor-aware menu wrapper.
 *
 *   • Desktop (mouse + non-TV) → DaisyUI `.dropdown` / `.dropdown-content`
 *     anchored sibling layout. Open/close handled by `appDropdownToggle`
 *     (click + outside-click + back-button via DismissableStackService).
 *   • Mobile / tablet / TV → BottomSheetComponent.
 *
 * Authoring:
 *
 *   <app-dropdown-menu placement="bottom-end">
 *     <button trigger type="button" class="btn btn-ghost btn-circle">…</button>
 *     <a routerLink="/account">…</a>
 *     <button (click)="logout()">…</button>
 *   </app-dropdown-menu>
 *
 * The element marked `trigger` is projected as the first child of
 * `.dropdown` on desktop so DaisyUI's `:focus-within` open path keeps
 * working alongside the click toggle. All other children are projected
 * into `.dropdown-content` (desktop) or the bottom sheet body (TV/touch).
 *
 * Both <ng-content> slots live inside <ng-template> refs and are rendered
 * via *ngTemplateOutlet — direct <ng-content> inside @if blocks does not
 * project reliably (Angular 21 still hits this case under nested control
 * flow).
 */
@Component({
  selector: 'app-dropdown-menu',
  standalone: true,
  imports: [NgTemplateOutlet, BottomSheetComponent, DropdownToggleDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #triggerTpl><ng-content select="[trigger]"></ng-content></ng-template>
    <ng-template #itemsTpl><ng-content></ng-content></ng-template>

    @if (useDropdown()) {
      <div class="dropdown" [class]="dropdownClasses()">
        <div appDropdownToggle class="contents">
          <ng-container *ngTemplateOutlet="triggerTpl"></ng-container>
        </div>
        <div
          tabindex="0"
          class="dropdown-content bg-base-200 rounded-box shadow-xl min-w-60 p-1 z-[101] overflow-hidden whitespace-nowrap"
        >
          <ng-container *ngTemplateOutlet="itemsTpl"></ng-container>
        </div>
      </div>
    } @else {
      <div class="contents" (click)="open.set(true)">
        <ng-container *ngTemplateOutlet="triggerTpl"></ng-container>
      </div>
      <app-bottom-sheet #sheet [open]="open()" (closed)="open.set(false)">
        <div data-tv-modal class="px-2 pb-2" (click)="onItemsClick($event)">
          <ng-container *ngTemplateOutlet="itemsTpl"></ng-container>
        </div>
      </app-bottom-sheet>
    }
  `,
})
export class DropdownMenuComponent {
  readonly placement = input<Placement>('bottom-end');

  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);

  readonly useDropdown = computed(() => !this.tv.isTv() && !this.device.isTouch());
  protected readonly open = signal(false);

  /** Reference to <app-bottom-sheet> on the touch/TV branch — used to
   *  reparent the sheet under <html> so its `position: fixed` resolves
   *  against the viewport instead of the layout's drawer-content (which
   *  has `position: relative` on mobile, creating a stacking context that
   *  traps `z-[101]` below the bottom dock at `z-40`). The trigger stays
   *  inline so the layout's flex/grid placement keeps working. */
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
    // The sheet host is moved under <html> to escape the drawer's stacking
    // context, so Angular no longer owns its DOM position and won't remove it
    // when this component is destroyed. Detach it ourselves — otherwise a
    // sheet torn down mid-close (its slide-down exit still running, e.g. an
    // item tap that navigates away) orphans its full-screen backdrop, which
    // keeps blocking clicks across the app.
    inject(DestroyRef).onDestroy(() => this.reparentedSheet?.remove());
    // Sheet branch (touch / TV) doesn't go through DropdownToggleDirective,
    // so refocus the projected trigger ourselves on close — keeps Enter /
    // tap parity with the dropdown branch (re-activating re-opens).
    effect(() => {
      const open = this.open();
      const justClosed = this.wasOpen && !open;
      this.wasOpen = open;
      if (!justClosed || this.useDropdown()) return;
      queueMicrotask(() => {
        this.host.nativeElement
          .querySelector<HTMLElement>('[trigger]')
          ?.focus({ preventScroll: true });
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

  /** Close on any click that lands on an `<a>` / `<button>` inside the
   *  sheet — mirrors the desktop `DropdownToggleDirective` behaviour
   *  (the directive's outside-click handler treats item clicks as
   *  "outside the trigger" and closes). Padding / spacer clicks are
   *  ignored so the sheet doesn't dismiss on stray taps. */
  protected onItemsClick(event: Event) {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button')) {
      this.open.set(false);
    }
  }
}
