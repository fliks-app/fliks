import { Entity, Column, OneToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Library } from '../../libraries/entities/library.entity';

@Entity('root_folders')
export class RootFolder extends BaseEntity {
  @Column({ unique: true })
  path: string;

  @Column({ nullable: true })
  label: string;

  /** Library this root path belongs to. Enforced 1:1 by DB constraint. */
  @OneToOne(() => Library, (lib) => lib.rootFolder, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'libraryId' })
  library: Library;

  @RelationId((rf: RootFolder) => rf.library)
  libraryId: number;
}
