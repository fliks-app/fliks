import type { User } from './auth.service';
import { SessionStoreService, type StoredSession } from './session-store.service';

const user = { id: 1, username: 'u', avatar: null } as User;
const base: StoredSession = {
  serverUrl: 'https://a',
  user,
  accessToken: null,
  refreshToken: 'T0',
  refreshExpiresAt: null,
  lastUsedAt: 1,
};
const tokens = (refreshToken: string) => ({
  accessToken: null,
  refreshToken,
  refreshExpiresAt: null,
});

describe('SessionStoreService write ordering', () => {
  beforeEach(() => localStorage.clear());

  it.each(['profile first', 'rotation first'])(
    'a concurrent profile write cannot put a rotated refresh token back (%s)',
    async (order) => {
      const store = new SessionStoreService();
      await store.save(base);

      const profile = () => store.updateUser('https://a', 1, { ...user, username: 'renamed' });
      const rotation = () => store.updateTokens('https://a', 1, tokens('T1'));
      await Promise.all(
        order === 'profile first' ? [profile(), rotation()] : [rotation(), profile()],
      );

      const stored = JSON.parse(localStorage.getItem('fliks_sessions')!) as StoredSession[];
      expect(stored[0].refreshToken).toBe('T1');
      expect(stored[0].user.username).toBe('renamed');
      expect(store.get('https://a', 1)?.refreshToken).toBe('T1');
    },
  );

  it('counts each rotation so adopters can tell which token is newer', async () => {
    const store = new SessionStoreService();
    await store.save(base);
    const v0 = store.get('https://a', 1)!.tokenVersion!;
    await store.updateTokens('https://a', 1, tokens('T1'));
    expect(store.get('https://a', 1)!.tokenVersion).toBe(v0 + 1);
  });
});
