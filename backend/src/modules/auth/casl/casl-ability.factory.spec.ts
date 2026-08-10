import { CaslAbilityFactory } from './casl-ability.factory';
import { Action } from './actions.enum';
import type { User } from '../../users/entities/user.entity';

function fakeUser(permissions: string[], isAdmin = false): User {
  // `User.permissions` is a getter that overrides to `['manage:all']` when `isAdmin` — mirror
  // that here rather than setting a plain `permissions` property the real class never has.
  return { id: 1, isAdmin, permissions: isAdmin ? ['manage:all'] : permissions } as unknown as User;
}

describe('CaslAbilityFactory — plugin-declared subjects', () => {
  const factory = new CaslAbilityFactory();

  it('grants a plugin subject to a user holding the exact namespaced permission', () => {
    const ability = factory.createForUser(fakeUser(['plugin:fliks.myplugin:download']));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(true);
    expect(ability.can(Action.Manage, 'plugin:fliks.myplugin:download')).toBe(true);
  });

  it('denies the subject to a user who does not hold that permission', () => {
    const ability = factory.createForUser(fakeUser([]));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(false);
  });

  it('never leaks a granted subject to a different plugin id', () => {
    const ability = factory.createForUser(fakeUser(['plugin:fliks.myplugin:download']));
    expect(ability.can(Action.Read, 'plugin:fliks.otherplugin:download')).toBe(false);
  });

  it('manage:all passes regardless of which plugin subject is asked for', () => {
    const ability = factory.createForUser(fakeUser([], true));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(true);
  });

  it('ignores a permission string that is not shaped like a plugin subject', () => {
    const ability = factory.createForUser(fakeUser(['media.read']));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(false);
  });
});
