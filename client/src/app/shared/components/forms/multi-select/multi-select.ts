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

export interface MultiSelectOption {
  value: number;
  label: string;
}

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
export class MultiSelectComponent {
  readonly options = input.required<readonly MultiSelectOption[]>();
  readonly value = model<number[]>([]);
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

  protected isPicked(value: number) {
    return this.value().includes(value);
  }

  protected toggleOpen() {
    if (this.disabled()) return;
    const width = this.trigger()?.nativeElement.offsetWidth;
    if (width) this.panelWidth.set(width);
    this.open.update((v) => !v);
  }

  protected toggleOption(value: number) {
    this.value.update((list) =>
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
  }

  protected remove(value: number, event: Event) {
    event.stopPropagation();
    this.value.update((list) => list.filter((v) => v !== value));
  }
}
