import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 0;
  readonly toasts = signal<Toast[]>([]);

  success(message: string, duration = 4000) {
    this.add(message, 'success', duration);
  }

  error(message: string, duration = 6000) {
    this.add(message, 'error', duration);
  }

  warning(message: string, duration = 5000) {
    this.add(message, 'warning', duration);
  }

  info(message: string, duration = 4000) {
    this.add(message, 'info', duration);
  }

  dismiss(id: number) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private add(message: string, type: ToastType, duration: number) {
    const id = this.nextId++;
    this.toasts.update((list) => [...list, { id, message, type, duration }]);

    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
  }
}
