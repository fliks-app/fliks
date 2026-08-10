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

/** Closed, case-sensitive subject vocabulary. A plugin-declared subject (`PermissionRegistry`,
 *  3.5c) is deliberately absent — it must fail `parseDeclaredPolicy`, not fall through here. */
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

/** `"<action>:<Subject>"`, both halves from the closed vocabularies above — a manifest is
 *  untrusted text, so a plugin-declared or wrong-case subject returns `null`, not a guess. */
export function parseDeclaredPolicy(policy: string): DeclaredPolicy | null {
  const parts = policy.split(':');
  if (parts.length !== 2) return null;
  const [action, subjectName] = parts;
  if (!ACTIONS.has(action)) return null;
  const subject = DECLARED_POLICY_SUBJECTS.get(subjectName);
  if (subject === undefined) return null;
  return { action: action as Action, subject };
}

/** Fail closed: an unparseable policy is denied, never treated as "no policy declared". */
export function checkDeclaredPolicy(policy: string, ability: AppAbility): boolean {
  const parsed = parseDeclaredPolicy(policy);
  if (!parsed) return false;
  return ability.can(parsed.action, parsed.subject);
}
