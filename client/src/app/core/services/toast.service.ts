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
  /** A pushed notification: bold title, thumbnail; `tv` drops the buttons and the close control so focus never moves. */
  title?: string;
  image?: string;
  tag?: string;
  tv?: boolean;
}

export interface NotificationToast {
  title: string;
  body: string;
  image?: string;
  /** A toast with the same tag is replaced. */
  tag?: string;
  tv: boolean;
  actions: ToastAction[];
}

const NOTIFICATION_MS = 10_000;
const NOTIFICATION_TV_MS = 6_000;

const CLOSED_QUIET_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 0;
  readonly toasts = signal<Toast[]>([]);
  private readonly closedAt = new Map<string, number>();

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

  notify(n: NotificationToast) {
    const tv = n.tv;
    const id = this.nextId++;
    const toast: Toast = {
      id, message: n.body, type: 'info', duration: tv ? NOTIFICATION_TV_MS : NOTIFICATION_MS,
      actions: tv ? [] : n.actions, title: n.title, image: n.image, tag: n.tag, tv,
    };
    this.toasts.update((list) => [...list.filter((t) => !n.tag || t.tag !== n.tag), toast]);
    setTimeout(() => this.dismiss(id), toast.duration);
  }

  /** A message the user closed by hand stays quiet for a while, so a repeating error does not reopen it. */
  close(id: number) {
    const t = this.toasts().find((x) => x.id === id);
    if (t) this.closedAt.set(t.message, Date.now());
    this.dismiss(id);
  }

  dismiss(id: number) {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private add(message: string, type: ToastType, duration: number, actions: ToastAction[] = []) {
    // A burst of identical failures (parallel calls on a dead server) shows once.
    const same = this.toasts().find((t) => t.message === message && t.type === type);
    if (same) return same.id;
    if (Date.now() - (this.closedAt.get(message) ?? 0) < CLOSED_QUIET_MS) return -1;
    const id = this.nextId++;
    this.toasts.update((list) => [...list, { id, message, type, duration, actions }]);

    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
    return id;
  }
}
