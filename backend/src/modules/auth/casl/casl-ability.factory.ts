import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
  InferSubjects,
} from '@casl/ability';
import { Injectable } from '@nestjs/common';
import { User } from '../../users/entities/user.entity';
import { Media } from '../../media/entities/media.entity';
import { SuitarrRequest } from '../../requests/entities/request.entity';
import { Indexer } from '../../indexers/entities/indexer.entity';
import { DownloadClient } from '../../download-clients/entities/download-client.entity';
import { QualityProfile } from '../../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../../profiles/entities/language-profile.entity';
import { Tag } from '../../tags/entities/tag.entity';
import { Action } from './actions.enum';
import { UserRole } from '../../../common/enums';

type Subjects =
  | InferSubjects<
      | typeof User
      | typeof Media
      | typeof SuitarrRequest
      | typeof Indexer
      | typeof DownloadClient
      | typeof QualityProfile
      | typeof LanguageProfile
      | typeof Tag
    >
  | 'Settings'
  | 'all';

export type AppAbility = MongoAbility<[Action, Subjects]>;

@Injectable()
export class CaslAbilityFactory {
  createForUser(user: User): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    switch (user.role) {
      case UserRole.ADMIN:
        can(Action.Manage, 'all');
        can(Action.Grab, Media);
        break;

      case UserRole.USER:
        can(Action.Read, Media);
        can(Action.Create, Media);
        can(Action.Grab, Media);
        can(Action.Read, Tag);
        can(Action.Read, QualityProfile);
        can(Action.Read, LanguageProfile);

        can(Action.Create, SuitarrRequest);
        can(Action.Read, SuitarrRequest, { userId: user.id } as any);
        can(Action.Delete, SuitarrRequest, {
          userId: user.id,
          status: 'pending',
        } as any);
        can(Action.Update, SuitarrRequest, {
          userId: user.id,
          status: 'pending',
        } as any);

        can(Action.Read, User, { id: user.id } as any);
        can(Action.Update, User, { id: user.id } as any);
        break;

      case UserRole.READONLY:
        can(Action.Read, Media);
        can(Action.Read, Tag);
        can(Action.Read, QualityProfile);
        can(Action.Read, LanguageProfile);
        can(Action.Read, SuitarrRequest, { userId: user.id } as any);
        can(Action.Read, User, { id: user.id } as any);
        break;
    }

    return build();
  }
}
