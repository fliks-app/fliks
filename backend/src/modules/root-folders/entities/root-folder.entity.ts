import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaType } from '../../../common/enums/media-type.enum';

@Entity('root_folders')
export class RootFolder extends BaseEntity {
  @Column({ unique: true })
  path: string;

  @Column({ nullable: true })
  label: string;

  @Column({ type: 'jsonb', default: [MediaType.MOVIE, MediaType.SERIES] })
  mediaTypes: MediaType[];
}
