import { MongoAbility, InferSubjects } from '@casl/ability';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { SuitarrRequest } from '../../requests/entities/request.entity';
import { Indexer } from '../../indexers/entities/indexer.entity';
import { DownloadClient } from '../../download-clients/entities/download-client.entity';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { Tag } from '../../tags/entities/tag.entity';
import { Action } from './actions.enum';
type Subjects = InferSubjects<typeof User | typeof Media | typeof SuitarrRequest | typeof Indexer | typeof DownloadClient | typeof QualityProfile | typeof LanguageProfile | typeof Tag> | 'Settings' | 'all';
export type AppAbility = MongoAbility<[Action, Subjects]>;
export declare class CaslAbilityFactory {
    createForUser(user: User): AppAbility;
}
export {};
