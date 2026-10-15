import { CaslAbilityFactory } from '../../src/modules/auth/casl/casl-ability.factory';
import { Action } from '../../src/modules/auth/casl/actions.enum';
import { PERMISSIONS } from '../../src/common/constants/permissions';
import { User as UserEntity } from '../../src/modules/users/entities/user.entity';
import { Media } from '../../src/modules/media/entities/media.entity';
import { FliksRequest } from '../../src/modules/requests/entities/request.entity';
import { QualityProfile } from '../../src/modules/profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../src/modules/profiles/entities/language-profile.entity';
import { SubtitleProvider } from '../../src/modules/subtitles/entities/subtitle-provider.entity';
import { SubtitleFile } from '../../src/modules/subtitles/entities/subtitle-file.entity';
import { TranslationProvider } from '../../src/modules/subtitles/entities/translation-provider.entity';
import { Library } from '../../src/modules/libraries/entities/library.entity';
import { Playlist } from '../../src/modules/playlists/entities/playlist.entity';
import { LiveTvChannel } from '../../src/modules/livetv/entities/livetv-channel.entity';
import { Role } from '../../src/modules/roles/entities/role.entity';
import { emit, mulberry32, pick } from './_util';

const USER_ID = 42;
const factory = new CaslAbilityFactory();
const CLASSES: Record<string, new () => object> = {
  User: UserEntity, Media, FliksRequest, QualityProfile, LanguageProfile, SubtitleProvider,
  SubtitleFile, TranslationProvider, Library, Playlist, LiveTvChannel, Role,
};
const STRINGS = ['Settings', 'all', 'plugin:fliks.myplugin:download', 'plugin:fliks.otherplugin:download'];
// Real class instances: CASL matches rule conditions on them (plain objects or string-tagged ones never match class rules).
const INSTANCES: Instance[] = [
  { name: 'User.self', type: 'User', value: { id: USER_ID } },
  { name: 'User.other', type: 'User', value: { id: USER_ID + 1 } },
  { name: 'FliksRequest.ownPending', type: 'FliksRequest', value: { userId: USER_ID, status: 'pending' } },
  { name: 'FliksRequest.ownApproved', type: 'FliksRequest', value: { userId: USER_ID, status: 'approved' } },
  { name: 'FliksRequest.otherPending', type: 'FliksRequest', value: { userId: USER_ID + 1, status: 'pending' } },
];
const ACTIONS = Object.values(Action);

type Instance = { name: string; type: string; value: Record<string, unknown> };
type Input = { label: string; userId: number; isAdmin: boolean; rolePermissions: string[]; instances: Instance[] };

function run(input: Input) {
  const { userId, isAdmin, rolePermissions } = input;
  const u = new UserEntity();
  u.id = userId;
  u.isAdmin = isAdmin;
  u.userRole = { permissions: rolePermissions } as Role;
  const ability = factory.createForUser(u);
  const checks: { action: string; subject: string; allowed: boolean }[] = [];
  for (const action of ACTIONS) {
    for (const name of Object.keys(CLASSES)) checks.push({ action, subject: name, allowed: ability.can(action, CLASSES[name] as never) });
    for (const s of STRINGS) checks.push({ action, subject: s, allowed: ability.can(action, s as never) });
    for (const i of input.instances) checks.push({ action, subject: i.name, allowed: ability.can(action, Object.assign(new CLASSES[i.type](), i.value) as never) });
  }
  return { checks };
}

const mk = (label: string, isAdmin: boolean, rolePermissions: string[]): Input => ({ label, userId: USER_ID, isAdmin, rolePermissions, instances: INSTANCES });
const inputs: Input[] = [
  mk('empty', false, []),
  mk('admin', true, []),
  mk('manage-all', false, ['manage:all']),
  mk('manage-all-with-others', false, ['media.read', 'manage:all']),
  ...PERMISSIONS.map((p) => mk(p, false, [p])),
  mk('plugin-full', false, ['plugin:fliks.myplugin:download']),
  mk('plugin-read', false, ['read:plugin:fliks.myplugin:download']),
  mk('plugin-manage', false, ['manage:plugin:fliks.myplugin:download']),
  mk('plugin-invalid-action', false, ['sudo:plugin:fliks.myplugin:download']),
  mk('plugin-malformed', false, ['plugin:', 'plugin', 'read:foo']),
  mk('unknown-permission', false, ['nope.nothing']),
  mk('all-permissions', false, [...PERMISSIONS]),
];
const rng = mulberry32(0x70506535);
const pool = [...PERMISSIONS, 'plugin:fliks.myplugin:download', 'read:plugin:fliks.otherplugin:download', 'bogus'];
for (let i = 0; i < 12; i++) {
  const n = 2 + Math.floor(rng() * 4);
  inputs.push(mk(`seed-${i}`, false, [...new Set(Array.from({ length: n }, () => pick(rng, pool)))]));
}

emit('acl', inputs, run);
