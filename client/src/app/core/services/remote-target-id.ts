import { signal } from '@angular/core';

/**
 * This device's remote-target id, `deviceId#tabNonce`, published by SseService
 * when it opens the stream.
 *
 * A leaf module on purpose: AuthService needs it to scope a logout to the device
 * logging out, and SseService already injects AuthService, so reading it through
 * dependency injection would close a cycle.
 */
export const currentTargetId = signal<string | null>(null);
