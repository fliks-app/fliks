import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';

export interface SearchableSelectOption {
  value: number;
  label: string;
}

/**
 * Generic single-select with a built-in filter input. Tailored for lists
 * long enough that scrolling alone gets old (hundreds of media titles).
 * Two-way `[(value)]`; emits `null` for "no selection". Closes on click
 * outside the host and on `Escape`. Autofocuses the search input on open
 * so the user can start typing immediately.
 */
@Component({
  selector: 'app-searchable-select',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './searchable-select.html',
  host: { class: 'relative inline-block' },
})
export class SearchableSelectComponent {
  readonly options = input.required<readonly SearchableSelectOption[]>();
  readonly value = model<number | null>(null);
  readonly placeholder = input<string>('');
  readonly emptyOptionLabel = input<string>('');
  readonly disabled = input<boolean>(false);
  /** Tailwind size suffix for the trigger button. */
  readonly size = input<'sm' | 'md'>('sm');
  readonly maxHeightClass = input<string>('max-h-64');

  protected readonly open = signal(false);
  protected readonly query = signal('');

  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>('searchInput');

  protected readonly current = computed(() =>
    this.options().find((o) => o.value === this.value()) ?? null,
  );

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.options();
    return this.options().filter((o) => o.label.toLowerCase().includes(q));
  });

  protected readonly triggerClasses = computed(() => {
    const size = this.size();
    return `select select-bordered w-full text-left flex items-center justify-between gap-2 select-${size}`;
  });

  constructor(private readonly host: ElementRef<HTMLElement>) {
    // Focus the search input the moment the dropdown opens so the user
    // doesn't have to click twice to start typing.
    effect(() => {
      if (this.open()) {
        queueMicrotask(() => {
          this.searchInput()?.nativeElement.focus();
          // Focus stays in the search box, so reveal the selection ourselves.
          this.host.nativeElement
            .querySelector('[aria-current="true"]')
            ?.scrollIntoView({ block: 'nearest' });
        });
      } else {
        this.query.set('');
      }
    });
  }

  protected toggle() {
    if (this.disabled()) return;
    this.open.update((v) => !v);
  }

  protected pick(value: number | null) {
    this.value.set(value);
    this.open.set(false);
  }

  protected onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      this.open.set(false);
      return;
    }
    if (event.key === 'Enter') {
      const first = this.filtered()[0];
      if (first) this.pick(first.value);
      event.preventDefault();
    }
  }

  /** Close on click outside the host. */
  @HostListener('document:mousedown', ['$event'])
  protected onDocumentMouseDown(event: MouseEvent) {
    if (!this.open()) return;
    if (this.host.nativeElement.contains(event.target as Node)) return;
    this.open.set(false);
  }
}
