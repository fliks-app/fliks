import { Component, computed, input, model } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LucideChevronDown, LucideChevronUp, LucideX } from '@lucide/angular';
import type { MultiSelectOption } from '../../../../shared/components/forms/multi-select/multi-select';

/** A preference list where the order is the value: rows move up and down, the add menu lists what is left. */
@Component({
  selector: 'app-ordered-list',
  imports: [TranslatePipe, LucideChevronDown, LucideChevronUp, LucideX],
  templateUrl: './ordered-list.html',
  host: { class: 'block' },
})
export class OrderedListComponent {
  readonly options = input.required<readonly MultiSelectOption<string>[]>();
  readonly value = model<string[]>([]);
  readonly ariaLabel = input<string | null>(null);

  readonly rows = computed(() => {
    const byId = new Map(this.options().map((o) => [o.value, o.label]));
    return this.value().map((v) => ({ value: v, label: byId.get(v) ?? v }));
  });
  readonly rest = computed(() => this.options().filter((o) => !this.value().includes(o.value)));

  add(v: string) {
    if (v) this.value.set([...this.value(), v]);
  }

  remove(i: number) {
    this.value.set(this.value().filter((_, j) => j !== i));
  }

  move(i: number, by: -1 | 1) {
    const next = [...this.value()];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    this.value.set(next);
  }
}
