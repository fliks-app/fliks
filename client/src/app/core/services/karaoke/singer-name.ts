import type { PartyService } from '../party/party.service';

/** The display name of a party member, guest or host. */
export function singerName(party: PartyService, userId: number): string {
  const p = party.party();
  const found = party.members().find((m) => m.userId === userId) ?? p?.guests.find((g) => g.userId === userId) ?? (p?.host.userId === userId ? p.host : null);
  return found?.username ?? '';
}
