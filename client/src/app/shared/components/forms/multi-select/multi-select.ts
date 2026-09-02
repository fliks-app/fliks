import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { PopoverMenuComponent } from '../../popover-menu';

export interface MultiSelectOption<T extends string | number = number> {
  value: T;
  label: string;
}

/** Below this many options the whole list is on screen at once, and a filter is one more control
 *  to skip past (plus a keyboard popping up on mobile). */
const FILTER_FROM_OPTIONS = 8;

/**
 * Multi-select with a built-in filter: the trigger shows the picked options
 * as removable chips, the panel stays open while ticking several. Sibling of
 * `app-searchable-select`, which is the single-value form.
 *
 * The panel is an `app-popover-menu`, which floats it out of any scrolling
 * ancestor — `.modal-box` is `overflow-y: auto` and would clip it — and turns
 * it into a bottom sheet on touch.
 *
 * <app-multi-select [(value)]="libraryIds" [options]="libraryOptions()"
 *   [placeholder]="'…' | translate" />
 */
@Component({
  selector: 'app-multi-select',
  standalone: true,
  imports: [FormsModule, TranslateModule, PopoverMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './multi-select.html',
  host: { class: 'block' },
})
export class MultiSelectComponent<T extends string | number = number> {
  readonly options = input.required<readonly MultiSelectOption<T>[]>();
  readonly value = model<T[]>([]);
  readonly placeholder = input<string>('');
  readonly disabled = input<boolean>(false);
  /** Chips shown on the trigger before collapsing the rest into "+N". */
  readonly maxChips = input<number>(3);

  protected readonly open = signal(false);
  protected readonly query = signal('');

  private readonly trigger = viewChild<ElementRef<HTMLElement>>('trigger');
  protected readonly anchor = computed(() => this.trigger()?.nativeElement ?? null);
  /** Match the field's width so the panel doesn't float narrower than its trigger. */
  protected readonly panelWidth = signal(240);

  private readonly selected = computed(() => {
    const byId = new Map(this.options().map((o) => [o.value, o]));
    return this.value()
      .map((v) => byId.get(v) ?? { value: v, label: `#${v}` })
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  protected readonly chips = computed(() => this.selected().slice(0, this.maxChips()));
  protected readonly overflowCount = computed(() =>
    Math.max(0, this.selected().length - this.maxChips()),
  );

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.options();
    return this.options().filter((o) => o.label.toLowerCase().includes(q));
  });

  constructor() {
    effect(() => {
      if (!this.open()) this.query.set('');
    });
  }

  protected readonly showFilter = computed(() => this.options().length > FILTER_FROM_OPTIONS);

  protected isPicked(value: T) {
    return this.value().includes(value);
  }

  protected toggleOpen() {
    if (this.disabled()) return;
    const width = this.trigger()?.nativeElement.offsetWidth;
    if (width) this.panelWidth.set(width);
    this.open.update((v) => !v);
  }

  protected toggleOption(value: T) {
    this.value.update((list) =>
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
  }

  /** Keeps a chip removal from focusing the trigger, which would light its focus ring for a
   *  click that never entered the field. */
  protected onChipMouseDown(event: Event) {
    event.preventDefault();
    event.stopPropagation();
  }

  /** The ✕ stays visible while disabled, dimmed and inert: `pointer-events` alone would still
   *  let a synthetic click through, and a form that said no must not lose a value. */
  protected remove(value: T, event: Event) {
    event.stopPropagation();
    if (this.disabled()) return;
    this.value.update((list) => list.filter((v) => v !== value));
  }
}
