import { Entity, Column, OneToMany, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { UserRole, MediaServerType } from '../../../common/enums';

@Entity('users')
export class User extends BaseEntity {
  @Column({ unique: true })
  username: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({ nullable: true, unique: true })
  apiKey: string;

  @Column({
    type: 'enum',
    enum: MediaServerType,
    default: MediaServerType.LOCAL,
  })
  mediaServerType: MediaServerType;

  @Column({ nullable: true })
  mediaServerId: string;

  @Column({ nullable: true })
  avatar: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastLogin: Date;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'int', default: 0 })
  movieQuotaLimit: number;

  @Column({ type: 'int', default: 0 })
  seriesQuotaLimit: number;

  @Column({ type: 'int', default: 7 })
  quotaPeriodDays: number;
}
