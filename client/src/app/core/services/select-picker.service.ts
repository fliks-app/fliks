import { Injectable, signal } from '@angular/core';

export interface SelectPickerOption {
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
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
    this.title.set(title);
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
    // Restore focus to the trigger so a subsequent Enter / Space re-opens
    // the picker — without this the browser drops focus to <body> when the
    // popover unmounts and the user has to Tab back to the select. Only
    // worth doing in keyboard / D-pad modality though: on iOS touch,
    // calling `focus()` on a `<select>` pops the native picker right
    // after we just dismissed our custom one. The `keyboard-modality`
    // body class (toggled by app.ts) plus `body.tv` cover every modality
    // where focus restoration is actually wanted.
    const wantsFocusRestore =
      document.body.classList.contains('keyboard-modality') ||
      document.body.classList.contains('tv');
    if (wantsFocusRestore) sel?.focus({ preventScroll: true });
  }
}
