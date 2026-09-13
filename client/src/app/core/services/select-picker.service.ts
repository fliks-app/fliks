import { Injectable, signal } from '@angular/core';
import { restoreOpenerFocus } from './focusable.constants';

export interface SelectPickerOption {
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
}

/** The field's visible label, so a select gets a sheet title without every
 *  call site repeating one. A wrapping daisyUI label also holds the hint text,
 *  hence the `.label-text` lookup before falling back to the whole label. */
function fieldLabel(select: HTMLSelectElement): string {
  const aria = select.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const label = select.labels?.[0];
  if (!label) return '';
  const primary = label.querySelector('.label-text');
  const text = primary?.textContent ?? (label.contains(select) ? '' : label.textContent);
  // A label reads "Mode :" in place; a sheet title does not want the colon.
  return text?.trim().replace(/[\s\u00a0]*:$/, '') ?? '';
}

/**
 * Singleton state for the TV-friendly <select> picker. The native picker on
 * Android WebView mixes inconsistent behaviours (option cycling, tab-style
 * jumps, partial back-button support). Selects opted-in via `appTvSelect`
 * route through this service to a styled popover instead.
 */
@Injectable({ providedIn: 'root' })
export class SelectPickerService {
  readonly open = signal(false);
  readonly anchor = signal<HTMLElement | null>(null);
  readonly options = signal<SelectPickerOption[]>([]);
  readonly title = signal<string>('');
  private currentSelect: HTMLSelectElement | null = null;

  show(select: HTMLSelectElement, title = '') {
    this.options.set(
      Array.from(select.options).map((o) => ({
        label: o.textContent?.trim() ?? '',
        value: o.value,
        selected: o.selected,
        disabled: o.disabled,
      })),
    );
    this.anchor.set(select);
    this.title.set(title || fieldLabel(select));
    this.currentSelect = select;
    this.open.set(true);
  }

  pick(value: string) {
    const sel = this.currentSelect;
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    this.close();
  }

  close() {
    const sel = this.currentSelect;
    this.open.set(false);
    this.currentSelect = null;
    // Restore focus to the trigger so a subsequent Enter / Space re-opens the
    // picker: the browser drops focus to <body> when the popover unmounts. The
    // modality test lives in `restoreOpenerFocus`, which every overlay shares.
    restoreOpenerFocus(sel);
  }
}
