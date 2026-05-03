import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Library } from '../../libraries/entities/library.entity';

@Entity('root_folders')
export class RootFolder extends BaseEntity {
  @Column({ unique: true })
  path: string;

  @Column({ nullable: true })
  label: string;

  /**
   * Library this root path belongs to. Nullable only for the transient window
   * between entity creation and the startup auto-wrap migration; after that,
   * every RootFolder has a library.
   */
  @ManyToOne(() => Library, (lib) => lib.rootFolders, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'libraryId' })
  library: Library | null;

  @RelationId((rf: RootFolder) => rf.library)
  libraryId: number | null;
}
