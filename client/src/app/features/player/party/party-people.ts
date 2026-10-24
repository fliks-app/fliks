import { type PartyGuest, type PartyGuestSource, type PartyMember, type PartyMemberStatus, type PartyUser } from '../../../core/services/api/party-api.service';

/** A person of the party: a live member or a guest not here, tagged by how they got in (`null` for the host). */
export interface PartyPerson {
  userId: number;
  username: string;
  host: boolean;
  connected: boolean;
  source: PartyGuestSource | null;
  status: PartyMemberStatus | null;
  voice: { muted: boolean } | null;
  speaking: boolean;
}

const rank = (p: PartyPerson): number => (p.connected ? 0 : p.source === 'link' ? 1 : p.source === 'invite' ? 2 : 3);

/** Merges the members (one row per user, whatever their devices) with the guests who are not in. */
export function partyPeople(
  host: PartyUser,
  guests: PartyGuest[],
  members: PartyMember[],
  speaking: ReadonlySet<string>,
): PartyPerson[] {
  const byUser = new Map<number, PartyPerson>();
  // A transfer moves the role among the members without touching the party's own host.
  const hostId = members.find((m) => m.role === 'host')?.userId ?? host.userId;
  for (const m of members) {
    const known = byUser.get(m.userId);
    if (known) {
      known.voice ??= m.voice;
      known.speaking ||= speaking.has(m.deviceId);
      if (known.status === 'ready' && m.status !== 'ready') known.status = m.status;
      continue;
    }
    const isHost = m.userId === hostId;
    byUser.set(m.userId, {
      userId: m.userId, username: m.username, host: isHost, connected: true,
      source: isHost ? null : (guests.find((g) => g.userId === m.userId)?.source ?? null),
      status: m.status, voice: m.voice, speaking: speaking.has(m.deviceId),
    });
  }
  const absent = (u: PartyUser, isHost: boolean, source: PartyGuestSource | null): PartyPerson => ({
    userId: u.userId, username: u.username, host: isHost, connected: false, source, status: null, voice: null, speaking: false,
  });
  if (!byUser.has(hostId)) byUser.set(hostId, absent(host, true, null));
  for (const g of guests) if (!byUser.has(g.userId)) byUser.set(g.userId, absent(g, false, g.source));
  return [...byUser.values()].sort((a, b) => Number(b.host) - Number(a.host) || rank(a) - rank(b));
}

export function connectedCount(people: PartyPerson[]): number {
  return people.filter((p) => p.connected).length;
}

/** Expected but not here: invitees, and the party's own host when someone else holds the role. */
export function missingCount(people: PartyPerson[]): number {
  return people.filter((p) => !p.connected && p.source !== 'link').length;
}

/** Voice is the player's business: pages outside it show people without it. */
export function withoutVoice(people: PartyPerson[]): PartyPerson[] {
  return people.map((p) => ({ ...p, voice: null, speaking: false }));
}
