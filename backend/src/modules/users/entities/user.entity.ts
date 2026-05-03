import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaServerType } from '../../../common/enums';
import { Role } from '../../roles/entities/role.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ unique: true })
  username: string;

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  passwordHash: string;

  @Column({ nullable: true })
  roleId: number;

  @ManyToOne(() => Role, { eager: true, onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'roleId' })
  userRole: Role | null;

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

  @Column({ default: false })
  isAdmin: boolean;

  @Column({ default: true })
  enabled: boolean;

  /**
   * Admin-set flag that forces the user to set a new password on their next
   * action. Cleared automatically when the user changes their own password
   * (UsersService.update).
   */
  @Column({ default: false })
  requirePasswordChange: boolean;

  @Column({ type: 'int', default: 0 })
  movieQuotaLimit: number;

  @Column({ type: 'int', default: 0 })
  seriesQuotaLimit: number;

  @Column({ type: 'int', default: 7 })
  quotaPeriodDays: number;

  /** Computed permissions from the linked role (isAdmin overrides with all). */
  get permissions(): string[] {
    if (this.isAdmin) {
      // Dynamic import would be circular; just return a known superset
      return ['manage:all'];
    }
    return this.userRole?.permissions ?? [];
  }
}
