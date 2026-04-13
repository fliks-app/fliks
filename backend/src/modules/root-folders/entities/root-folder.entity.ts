import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType } from '../../../common/enums/media-type.enum';
import { StalledCleanupProfileKey } from '../../../common/constants/stalled-cleanup-profiles';

@Entity('root_folders')
export class RootFolder extends BaseEntity {
  @Column({ unique: true })
  path: string;

  @Column({ nullable: true })
  label: string;

  @Column({ type: 'jsonb', default: [MediaType.MOVIE, MediaType.SERIES] })
  mediaTypes: MediaType[];

  @Column({ type: 'varchar', nullable: true, default: null })
  preferredProvider: string | null;

  /**
   * Stalled-download cleanup profile applied to torrents landing in this root folder.
   * `null` disables cleanup for this root.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  stalledCleanupProfile: StalledCleanupProfileKey | null;
}
