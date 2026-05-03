import { Injectable, signal } from '@angular/core';

export type ConfirmVariant = 'danger' | 'warning' | 'info' | 'default';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Third button label — when set, clicking outside or this button resolves to null. */
  dismissLabel?: string;
  variant?: ConfirmVariant;
}

interface InternalConfirmState extends ConfirmOptions {
  alertOnly: boolean;
  resolve: (value: boolean | null) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmationService {
  readonly state = signal<InternalConfirmState | null>(null);

  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.state.set({
        ...options,
        alertOnly: false,
        resolve: (v) => resolve(v === true),
      });
    });
  }

  /** Three-outcome confirm: true (confirm), false (cancel), null (dismiss / click outside). */
  choose(options: ConfirmOptions): Promise<boolean | null> {
    return new Promise<boolean | null>((resolve) => {
      this.state.set({ ...options, alertOnly: false, resolve });
    });
  }

  alert(options: ConfirmOptions): Promise<void> {
    return new Promise<void>((resolve) => {
      this.state.set({
        ...options,
        alertOnly: true,
        resolve: () => resolve(),
      });
    });
  }

  accept() {
    this.state()?.resolve(true);
    this.state.set(null);
  }

  cancel() {
    this.state()?.resolve(false);
    this.state.set(null);
  }

  dismiss() {
    this.state()?.resolve(null);
    this.state.set(null);
  }
}
