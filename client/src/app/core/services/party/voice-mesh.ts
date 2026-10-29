import type { PartyMember, PartySignalKind } from '../api/party-api.service';

/** A voice peer: a device is only unique within its user, so the pair identifies it. */
export interface PeerId {
  userId: number;
  deviceId: string;
}

export const peerKey = (p: PeerId): string => `${p.userId}:${p.deviceId}`;

/** The lower key sends the offer, so two peers never offer at once. */
export function offersTo(me: PeerId, other: PeerId): boolean {
  return peerKey(me) < peerKey(other);
}

/** Peers to open (ids) and close (keys) so the mesh matches the voice members; an `away` member is dropped until it returns. */
export function diffPeers(
  current: Iterable<string>,
  members: readonly PartyMember[],
  me: PeerId,
): { add: PeerId[]; remove: string[] } {
  const meKey = peerKey(me);
  const wanted = new Map(
    members.filter((m) => m.voice && m.status !== 'away' && peerKey(m) !== meKey).map((m) => [peerKey(m), { userId: m.userId, deviceId: m.deviceId }]),
  );
  const have = new Set(current);
  return {
    add: [...wanted].filter(([k]) => !have.has(k)).map(([, id]) => id),
    remove: [...have].filter((k) => !wanted.has(k)),
  };
}

export type SignalAction = 'accept-offer' | 'apply-answer' | 'add-ice' | 'close' | 'retry' | 'ignore';

/** An offer always replaces the peer (the sender restarted); anything else needs a live peer. */
export function routeSignal(kind: PartySignalKind, hasPeer: boolean, retry: boolean): SignalAction {
  if (kind === 'offer') return 'accept-offer';
  if (!hasPeer) return 'ignore';
  if (kind === 'answer') return 'apply-answer';
  if (kind === 'ice') return 'add-ice';
  return retry ? 'retry' : 'close';
}

export const SPEAK_THRESHOLD = 0.02;
export const SPEAK_HANG_MS = 300;

/** RMS of a time-domain byte buffer centred on 128, 0..1. */
export function rms(samples: Uint8Array): number {
  let sum = 0;
  for (const v of samples) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / (samples.length || 1));
}
