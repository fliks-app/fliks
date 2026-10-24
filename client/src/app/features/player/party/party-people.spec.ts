import { type PartyMember } from '../../../core/services/api/party-api.service';
import { connectedCount, partyPeople } from './party-people';

const member = (userId: number, deviceId: string, status: PartyMember['status'], role: PartyMember['role'] = 'member'): PartyMember =>
  ({ userId, username: `u${userId}`, deviceId, role, status, deviceName: null, formFactor: null, voice: null });

describe('partyPeople', () => {
  const host = { userId: 1, username: 'u1' };
  const invitees = [{ userId: 2, username: 'u2' }, { userId: 3, username: 'u3' }];

  it('lists connected members first and invitees who are not in as invited', () => {
    const people = partyPeople(host, invitees, [member(1, 'a', 'ready', 'host'), member(3, 'c', 'waiting')], new Set());
    expect(people.map((p) => [p.userId, p.state, p.status])).toEqual([
      [1, 'connected', 'ready'],
      [3, 'connected', 'waiting'],
      [2, 'invited', null],
    ]);
    expect(connectedCount(people)).toBe(2);
  });

  it('marks the host absent when not in, and a non-invited member as link', () => {
    const people = partyPeople(host, invitees, [member(9, 'z', 'ready')], new Set());
    expect(people.map((p) => [p.userId, p.state])).toEqual([[1, 'absent'], [9, 'link'], [2, 'invited'], [3, 'invited']]);
  });

  it('folds a user on two devices into one row with the least ready status', () => {
    const people = partyPeople(host, invitees, [member(2, 'a', 'ready'), member(2, 'b', 'buffering')], new Set());
    expect(people.filter((p) => p.userId === 2)).toHaveLength(1);
    expect(people.find((p) => p.userId === 2)?.status).toBe('buffering');
  });
});
