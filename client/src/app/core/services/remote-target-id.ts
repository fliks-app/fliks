import { signal } from '@angular/core';

/** This device's remote-target id (`deviceId#tabNonce`), published by SseService on opening the stream.
 *  A leaf module because AuthService needs it and SseService already injects AuthService; DI would close a cycle. */
export const currentTargetId = signal<string | null>(null);

/** The device part of a target id: it outlives a page load, the nonce does not. */
export function deviceIdOf(targetId: string): string {
  return targetId.split('#')[0];
}

/** Whether `owner` is `me`: the same target, or the same device's `#native` face and its web layer (the server's `continues` rule). */
export function sameTarget(owner: string, me: string): boolean {
  return owner === me || (deviceIdOf(owner) === deviceIdOf(me) && (owner.endsWith('#native') || me.endsWith('#native')));
}
