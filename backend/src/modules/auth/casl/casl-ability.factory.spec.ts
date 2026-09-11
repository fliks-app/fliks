import { CaslAbilityFactory } from './casl-ability.factory';
import { Action } from './actions.enum';
import type { User } from '../../users/entities/user.entity';
import { User as UserEntity } from '../../users/entities/user.entity';
import { Role } from '../../roles/entities/role.entity';

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

  it('narrows an action-prefixed grant to that action alone', () => {
    const ability = factory.createForUser(fakeUser(['read:plugin:fliks.myplugin:download']));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(true);
    expect(ability.can(Action.Manage, 'plugin:fliks.myplugin:download')).toBe(false);
    expect(ability.can(Action.Delete, 'plugin:fliks.myplugin:download')).toBe(false);
  });

  it('denies a grant prefixed with an action the enum does not know', () => {
    const ability = factory.createForUser(fakeUser(['sudo:plugin:fliks.myplugin:download']));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(false);
    expect(ability.can(Action.Manage, 'plugin:fliks.myplugin:download')).toBe(false);
  });

  it('ignores a permission string that is not shaped like a plugin subject', () => {
    const ability = factory.createForUser(fakeUser(['media.read']));
    expect(ability.can(Action.Read, 'plugin:fliks.myplugin:download')).toBe(false);
  });
});

describe('CaslAbilityFactory: users and roles are separate permissions', () => {
  const factory = new CaslAbilityFactory();

  it('lets users.manage list roles without editing them', () => {
    const ability = factory.createForUser(fakeUser(['users.manage']));
    expect(ability.can(Action.Manage, UserEntity)).toBe(true);
    expect(ability.can(Action.Read, Role)).toBe(true);
    expect(ability.can(Action.Manage, Role)).toBe(false);
  });

  it('lets roles.manage edit roles without touching users', () => {
    const ability = factory.createForUser(fakeUser(['roles.manage']));
    expect(ability.can(Action.Manage, Role)).toBe(true);
    expect(ability.can(Action.Manage, UserEntity)).toBe(false);
  });

  it('denies both to a role holding neither', () => {
    const ability = factory.createForUser(fakeUser(['media.read']));
    expect(ability.can(Action.Read, Role)).toBe(false);
    expect(ability.can(Action.Manage, UserEntity)).toBe(false);
  });
});
