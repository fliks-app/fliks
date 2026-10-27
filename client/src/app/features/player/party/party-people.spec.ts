import { type PartyMember } from '../../../core/services/api/party-api.service';
import { connectedCount, missingCount, partyPeople } from './party-people';

const member = (userId: number, deviceId: string, status: PartyMember['status'], role: PartyMember['role'] = 'member'): PartyMember =>
  ({ userId, username: `u${userId}`, deviceId, role, status, deviceName: null, formFactor: null, voice: null });

describe('partyPeople', () => {
  const host = { userId: 1, username: 'u1' };
  const invitees = [
    { userId: 2, username: 'u2', source: 'invite' as const },
    { userId: 3, username: 'u3', source: 'invite' as const },
  ];

  it('lists connected members first and invitees who are not in as invited', () => {
    const people = partyPeople(host, invitees, [member(1, 'a', 'ready', 'host'), member(3, 'c', 'waiting')], new Set());
    expect(people.map((p) => [p.userId, p.connected, p.source, p.status])).toEqual([
      [1, true, null, 'ready'],
      [3, true, 'invite', 'waiting'],
      [2, false, 'invite', null],
    ]);
    expect(connectedCount(people)).toBe(2);
  });

  it('marks the host absent when not in', () => {
    const people = partyPeople(host, invitees, [member(2, 'z', 'ready')], new Set());
    expect(people.map((p) => [p.userId, p.connected, p.source])).toEqual([[1, false, null], [2, true, 'invite'], [3, false, 'invite']]);
  });

  it('keeps a link joiner as link, connected or not, and does not count them as missing', () => {
    const guests = [...invitees, { userId: 9, username: 'u9', source: 'link' as const }];
    const here = partyPeople(host, guests, [member(1, 'a', 'ready', 'host'), member(9, 'z', 'buffering')], new Set());
    expect(here.find((p) => p.userId === 9)).toMatchObject({ connected: true, source: 'link', status: 'buffering' });
    const gone = partyPeople(host, guests, [member(1, 'a', 'ready', 'host')], new Set());
    expect(gone.find((p) => p.userId === 9)).toMatchObject({ connected: false, source: 'link' });
    expect(missingCount(gone)).toBe(2);
  });

  it('does not count a public joiner as missing either', () => {
    const guests = [...invitees, { userId: 9, username: 'u9', source: 'public' as const }];
    expect(missingCount(partyPeople(host, guests, [member(1, 'a', 'ready', 'host')], new Set()))).toBe(2);
  });

  it('folds a user on two devices into one row with the least ready status', () => {
    const people = partyPeople(host, invitees, [member(2, 'a', 'ready'), member(2, 'b', 'buffering')], new Set());
    expect(people.filter((p) => p.userId === 2)).toHaveLength(1);
    expect(people.find((p) => p.userId === 2)?.status).toBe('buffering');
  });
});
