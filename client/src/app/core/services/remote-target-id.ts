import { signal } from '@angular/core';

/** This device's remote-target id (`deviceId#tabNonce`), published by SseService on opening the stream.
 *  A leaf module because AuthService needs it and SseService already injects AuthService; DI would close a cycle. */
export const currentTargetId = signal<string | null>(null);
