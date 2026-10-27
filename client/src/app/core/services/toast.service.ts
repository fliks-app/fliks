import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  actions: ToastAction[];
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 0;
  readonly toasts = signal<Toast[]>([]);

  success(message: string, duration = 4000, ...actions: ToastAction[]) {
    this.add(message, 'success', duration, actions);
  }

  error(message: string, duration = 6000) {
    this.add(message, 'error', duration);
  }

  warning(message: string, duration = 5000) {
    this.add(message, 'warning', duration);
  }

  info(message: string, duration = 4000, ...actions: ToastAction[]) {
    return this.add(message, 'info', duration, actions);
  }

  dismiss(id: number) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private add(message: string, type: ToastType, duration: number, actions: ToastAction[] = []) {
    // A burst of identical failures (parallel calls on a dead server) shows once.
    const same = this.toasts().find((t) => t.message === message && t.type === type);
    if (same) return same.id;
    const id = this.nextId++;
    this.toasts.update((list) => [...list, { id, message, type, duration, actions }]);

    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
    return id;
  }
}
