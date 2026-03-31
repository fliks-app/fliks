import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('remote_path_mappings')
export class RemotePathMapping extends BaseEntity {
  @Column({ nullable: true })
  downloadClientId: number;

  @Column()
  remotePath: string;

  @Column()
  localPath: string;
}
