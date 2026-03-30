import { Injectable, signal } from '@angular/core';

export type ConfirmVariant = 'danger' | 'warning' | 'info' | 'default';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
}

interface InternalConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmationService {
  readonly state = signal<InternalConfirmState | null>(null);

  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.state.set({ ...options, resolve });
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
}
