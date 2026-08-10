import { Action } from '../../auth/casl/actions.enum';
import type { AppAbility } from '../../auth/casl/casl-ability.factory';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { FliksRequest } from '../../requests/entities/request.entity';
import { Indexer } from '../../indexers/entities/indexer.entity';
import { DownloadClient } from '../../download-clients/entities/download-client.entity';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { SubtitleProvider } from '../../subtitles/entities/subtitle-provider.entity';
import { SubtitleFile } from '../../subtitles/entities/subtitle-file.entity';
import { TranslationProvider } from '../../subtitles/entities/translation-provider.entity';
import { Library } from '../../libraries/entities/library.entity';
import { Playlist } from '../../playlists/entities/playlist.entity';

type PolicySubject = Parameters<AppAbility['can']>[1];

const ACTIONS: ReadonlySet<string> = new Set(Object.values(Action));

/** Closed, case-sensitive core subject vocabulary. A namespaced plugin subject
 *  (`plugin:<id>:<name>`) is never in here — it is only ever accepted via `declaredSubjects`. */
const DECLARED_POLICY_SUBJECTS = new Map<string, PolicySubject>([
  ['User', User],
  ['Media', Media],
  ['FliksRequest', FliksRequest],
  ['Indexer', Indexer],
  ['DownloadClient', DownloadClient],
  ['QualityProfile', QualityProfile],
  ['LanguageProfile', LanguageProfile],
  ['SubtitleProvider', SubtitleProvider],
  ['SubtitleFile', SubtitleFile],
  ['TranslationProvider', TranslationProvider],
  ['Library', Library],
  ['Playlist', Playlist],
  ['Settings', 'Settings'],
]);

export interface DeclaredPolicy {
  action: Action;
  subject: PolicySubject;
}

/**
 * `"<action>:<Subject>"` — only the first colon separates them, since a namespaced plugin
 * subject (`plugin:<id>:<name>`) carries two more of its own. `declaredSubjects` is always
 * built by the caller for the one plugin whose route this is, so a subject namespaced under
 * a *different* plugin id is never a member and fails closed here, same as an unknown one.
 */
export function parseDeclaredPolicy(policy: string, declaredSubjects?: ReadonlySet<string>): DeclaredPolicy | null {
  const sep = policy.indexOf(':');
  if (sep === -1) return null;
  const action = policy.slice(0, sep);
  const subjectName = policy.slice(sep + 1);
  if (!ACTIONS.has(action)) return null;

  const coreSubject = DECLARED_POLICY_SUBJECTS.get(subjectName);
  if (coreSubject !== undefined) return { action: action as Action, subject: coreSubject };

  if (declaredSubjects?.has(subjectName)) {
    return { action: action as Action, subject: subjectName as PolicySubject };
  }
  return null;
}

/** Fail closed: an unparseable policy is denied, never treated as "no policy declared". */
export function checkDeclaredPolicy(policy: string, ability: AppAbility, declaredSubjects?: ReadonlySet<string>): boolean {
  const parsed = parseDeclaredPolicy(policy, declaredSubjects);
  if (!parsed) return false;
  return ability.can(parsed.action, parsed.subject);
}
