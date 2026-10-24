import { type PartyMember, type PartyMemberStatus, type PartyUser } from '../../../core/services/api/party-api.service';

/** A person of the party: a live member, an invitee not here yet, or someone who came through the link. */
export interface PartyPerson {
  userId: number;
  username: string;
  host: boolean;
  state: 'connected' | 'invited' | 'link' | 'absent';
  status: PartyMemberStatus | null;
  voice: { muted: boolean } | null;
  speaking: boolean;
}

const STATE_RANK = { connected: 0, link: 1, invited: 2, absent: 3 } as const;

/** Merges the members (one row per user, whatever their devices) with the invitees who are not in. */
export function partyPeople(
  host: PartyUser,
  invitees: PartyUser[],
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
    const invited = invitees.some((i) => i.userId === m.userId);
    byUser.set(m.userId, {
      userId: m.userId, username: m.username, host: m.userId === hostId,
      state: invited || m.userId === hostId ? 'connected' : 'link',
      status: m.status, voice: m.voice, speaking: speaking.has(m.deviceId),
    });
  }
  const absent = (u: PartyUser, isHost: boolean, state: PartyPerson['state']): PartyPerson => ({
    userId: u.userId, username: u.username, host: isHost, state, status: null, voice: null, speaking: false,
  });
  if (!byUser.has(hostId)) byUser.set(hostId, absent(host, true, 'absent'));
  for (const i of invitees) if (!byUser.has(i.userId)) byUser.set(i.userId, absent(i, false, 'invited'));
  return [...byUser.values()].sort((a, b) => Number(b.host) - Number(a.host) || STATE_RANK[a.state] - STATE_RANK[b.state]);
}

export function connectedCount(people: PartyPerson[]): number {
  return people.filter((p) => p.state === 'connected' || p.state === 'link').length;
}
