import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MediaServerType, ProfileVisibility } from '../../../common/enums';
import { Role } from '../../roles/entities/role.entity';

@Entity('users')
export class User extends BaseEntity {
  @Column({ unique: true })
  username: string;

  @Column({ nullable: true })
  email: string;

  /**
   * Bcrypt hash. Double-locked against leaking through API responses:
   * `select: false` keeps it out of every default load (readers must
   * `addSelect` it explicitly), and `@Exclude` strips it from any User
   * instance that still reaches the global ClassSerializerInterceptor.
   */
  @Column({ nullable: true, select: false })
  @Exclude()
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

  /**
   * Per-user library display order (library ids, first to last). Drives the
   * home page and sidebar ordering for this account across devices. Empty
   * means no custom order — surfaces fall back to the default name ordering.
   * Ids absent from this list sort after the ordered ones.
   */
  @Column({ type: 'jsonb', default: [] })
  libraryOrder: number[];

  /**
   * Per-user hidden libraries (ids), kept out of the home page and sidebar for
   * this account. A display preference only — it doesn't change library access
   * or request targeting.
   */
  @Column({ type: 'jsonb', default: [] })
  hiddenLibraryIds: number[];

  /**
   * Social discoverability. `PRIVATE` (default): findable in member search, but
   * following needs approval and a non-follower sees only name + avatar.
   * `PUBLIC`: instant follow and shared content visible to any member.
   */
  @Column({
    type: 'enum',
    enum: ProfileVisibility,
    default: ProfileVisibility.PRIVATE,
  })
  profileVisibility: ProfileVisibility;

  /** Expose the derived "top genres" taste summary on the public profile. */
  @Column({ default: false })
  shareTastes: boolean;

  /** Expose personal recommendations on the public profile. */
  @Column({ default: false })
  shareRecommendations: boolean;

  /** Expose the recently-watched list on the public profile. */
  @Column({ default: false })
  shareWatchHistory: boolean;

  /** Computed permissions from the linked role (isAdmin overrides with all). */
  get permissions(): string[] {
    if (this.isAdmin) {
      // Dynamic import would be circular; just return a known superset
      return ['manage:all'];
    }
    return this.userRole?.permissions ?? [];
  }
}
