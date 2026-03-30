import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaServerType } from '../../../common/enums';

@Entity('media_servers')
export class MediaServer extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'enum', enum: MediaServerType })
  type: MediaServerType;

  @Column()
  url: string;

  @Column({ nullable: true })
  apiKey: string;

  @Column({ default: true })
  enabled: boolean;
}
