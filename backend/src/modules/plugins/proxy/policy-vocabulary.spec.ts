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
    // A plugin-declared subject is refused unless the caller supplies the declaring
    // plugin's own set (see the `declaredSubjects` describe block below).
    ['plugin-declared subject, no declaredSubjects given', 'read:plugin:fliks.myplugin:download'],
  ])('%s ("%s") -> null', (_label, policy) => {
    expect(parseDeclaredPolicy(policy)).toBeNull();
  });
});

describe('parseDeclaredPolicy — declaredSubjects (plugin-aware)', () => {
  it('accepts a namespaced subject declared in the given set', () => {
    const declared = new Set(['plugin:fliks.myplugin:download']);
    expect(parseDeclaredPolicy('read:plugin:fliks.myplugin:download', declared)).toEqual({
      action: Action.Read,
      subject: 'plugin:fliks.myplugin:download',
    });
  });

  it('refuses a subject namespaced under a different plugin id, even if that plugin declared the same name', () => {
    const declared = new Set(['plugin:fliks.myplugin:download']);
    expect(parseDeclaredPolicy('read:plugin:fliks.otherplugin:download', declared)).toBeNull();
  });

  it('refuses a subject the plugin never declared', () => {
    const declared = new Set(['plugin:fliks.myplugin:upload']);
    expect(parseDeclaredPolicy('read:plugin:fliks.myplugin:download', declared)).toBeNull();
  });

  it('still resolves a core subject even when a declaredSubjects set is passed', () => {
    expect(parseDeclaredPolicy('grab:Media', new Set(['plugin:fliks.myplugin:download']))).toEqual({
      action: Action.Grab,
      subject: Media,
    });
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

  it('permits a namespaced subject declared by the plugin when the ability grants it', () => {
    const allowed = ability((can) => can(Action.Manage, 'plugin:fliks.myplugin:download'));
    const declared = new Set(['plugin:fliks.myplugin:download']);
    expect(checkDeclaredPolicy('read:plugin:fliks.myplugin:download', allowed, declared)).toBe(true);
  });

  it('denies a namespaced subject the ability grants but this plugin never declared', () => {
    const allowed = ability((can) => can(Action.Manage, 'plugin:fliks.myplugin:download'));
    const declared = new Set<string>();
    expect(checkDeclaredPolicy('read:plugin:fliks.myplugin:download', allowed, declared)).toBe(false);
  });
});
