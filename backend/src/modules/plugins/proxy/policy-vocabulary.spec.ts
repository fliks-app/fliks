import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type { AppAbility } from '../../auth/casl/casl-ability.factory';
import { Action } from '../../auth/casl/actions.enum';
import { Media } from '../../media/entities/media.entity';
import { checkDeclaredPolicy, parseDeclaredPolicy } from './policy-vocabulary';

function ability(setup: (can: AbilityBuilder<AppAbility>['can']) => void): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  setup(can);
  return build();
}

describe('parseDeclaredPolicy', () => {
  it('parses a valid action:Subject pair', () => {
    expect(parseDeclaredPolicy('grab:Media')).toEqual({ action: Action.Grab, subject: Media });
  });

  it.each([
    ['unparseable text', 'not-a-policy'],
    ['unknown action', 'fly:Media'],
    ['unknown subject', 'grab:Spaceship'],
    ['wrong-case subject', 'grab:media'],
    ['empty string', ''],
    ['"manage" with no colon', 'manage'],
    ['three-part string', 'a:b:c'],
    // A plugin-declared subject (e.g. "read:download") needs `PermissionRegistry` (3.5c) —
    // out of scope here, and must be refused, not silently accepted.
    ['plugin-declared subject', 'read:download'],
  ])('%s ("%s") -> null', (_label, policy) => {
    expect(parseDeclaredPolicy(policy)).toBeNull();
  });
});

describe('checkDeclaredPolicy', () => {
  it('permits when the ability allows the parsed action:subject', () => {
    const allowed = ability((can) => can(Action.Grab, Media));
    expect(checkDeclaredPolicy('grab:Media', allowed)).toBe(true);
  });

  it('denies when the ability does not allow the parsed action:subject', () => {
    const denied = ability(() => {});
    expect(checkDeclaredPolicy('grab:Media', denied)).toBe(false);
  });

  it('fails closed on an unparseable policy regardless of how permissive the ability is', () => {
    const allowAll = ability((can) => can(Action.Manage, 'all'));
    expect(checkDeclaredPolicy('not-a-policy', allowAll)).toBe(false);
  });
});
