import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
  InferSubjects,
} from '@casl/ability';
import { Injectable } from '@nestjs/common';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { FliksRequest } from '../../requests/entities/request.entity';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { SubtitleProvider } from '../../subtitles/entities/subtitle-provider.entity';
import { SubtitleFile } from '../../subtitles/entities/subtitle-file.entity';
import { TranslationProvider } from '../../subtitles/entities/translation-provider.entity';
import { Library } from '../../libraries/entities/library.entity';
import { Playlist } from '../../playlists/entities/playlist.entity';
import { Action } from './actions.enum';
import { isPluginPermissionSubject } from '../../../common/constants/plugin-permissions';

type Subjects =
  | InferSubjects<
      | typeof User
      | typeof Media
      | typeof FliksRequest
      | typeof QualityProfile
      | typeof LanguageProfile
      | typeof SubtitleProvider
      | typeof SubtitleFile
      | typeof TranslationProvider
      | typeof Library
      | typeof Playlist
    >
  | 'Settings'
  | 'all'
  /** A namespaced plugin subject (`plugin:<id>:<name>`) — see `common/constants/plugin-permissions`. */
  | `plugin:${string}`;

export type AppAbility = MongoAbility<[Action, Subjects]>;

@Injectable()
export class CaslAbilityFactory {
  createForUser(user: User): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    // Super-admin / rôle avec manage:all — aligné sur User.permissions (getter)
    if (user.permissions.includes('manage:all')) {
      can(Action.Manage, 'all');
      return build();
    }

    const perms = new Set(user.permissions);

    // Self-contained: `PluginRouteGuard` re-checks the subject against that same plugin's
    // declared set, so granting it here needs no live plugin registry at all.
    for (const perm of perms) {
      if (isPluginPermissionSubject(perm)) can(Action.Manage, perm as `plugin:${string}`);
    }

    // Every authenticated user can read/update themselves
    can(Action.Read, User, { id: user.id } as any);
    can(Action.Update, User, { id: user.id } as any);

    // Every authenticated user may use playlists. This only opens the feature;
    // the per-playlist owner/administrator/editor/viewer rules are enforced in
    // PlaylistsService (CASL sees the class, never the instance).
    can(Action.Read, Playlist);
    can(Action.Create, Playlist);
    can(Action.Update, Playlist);
    can(Action.Delete, Playlist);

    // --- media ---
    if (perms.has('media.read')) {
      can(Action.Read, Media);
      can(Action.Read, QualityProfile);
      can(Action.Read, LanguageProfile);
      can(Action.Read, SubtitleFile);
      can(Action.Read, SubtitleProvider);
      can(Action.Read, Library);
    }
    if (perms.has('media.create')) can(Action.Create, Media);
    if (perms.has('media.edit')) can(Action.Update, Media);
    if (perms.has('media.delete')) can(Action.Delete, Media);
    if (perms.has('media.grab')) can(Action.Grab, Media);

    // --- read-only acquisition-progress access for users who can add/request media ---
    if (perms.has('media.create') || perms.has('requests.create')) {
      can(Action.Track, Media);
    }

    // --- requests ---
    if (perms.has('requests.create')) {
      can(Action.Create, FliksRequest);
      can(Action.Read, FliksRequest, { userId: user.id } as any);
      can(Action.Delete, FliksRequest, {
        userId: user.id,
        status: 'pending',
      } as any);
      can(Action.Update, FliksRequest, {
        userId: user.id,
        status: 'pending',
      } as any);
    }
    if (perms.has('requests.manage')) {
      can(Action.Manage, FliksRequest);
    }

    // --- subtitles ---
    if (perms.has('subtitles.manage')) {
      can(Action.Create, SubtitleFile);
      can(Action.Update, SubtitleFile);
      can(Action.Delete, SubtitleFile);
    }

    // --- settings ---
    if (perms.has('settings.access')) {
      can(Action.Read, 'Settings');
      can(Action.Manage, 'Settings');
      can(Action.Manage, QualityProfile);
      can(Action.Manage, LanguageProfile);
      can(Action.Manage, SubtitleProvider);
      can(Action.Manage, TranslationProvider);
      can(Action.Manage, Library);
    }

    // --- users ---
    if (perms.has('users.manage')) {
      can(Action.Manage, User);
    }

    return build();
  }
}
