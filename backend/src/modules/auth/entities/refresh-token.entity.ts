import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

/**
 * Long-lived refresh token. The plaintext is only ever returned to the
 * client on issuance; the DB stores the SHA-256 hash so a leaked
 * database dump can't be replayed against the service.
 *
 * Rotation policy: a refresh call always revokes the presented token
 * and issues a fresh one. Reusing a previously-rotated token is taken
 * as evidence of theft and revokes every refresh token of that user
 * (forces a full re-login on every device).
 */
@Entity('refresh_tokens')
@Index('IDX_refresh_tokens_userId', ['user'])
export class RefreshToken extends BaseEntity {
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column()
  userId: number;

  /** SHA-256 hex of the raw token. Indexed for O(1) lookup at refresh time. */
  @Index('IDX_refresh_tokens_tokenHash')
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /**
   * User-Agent at issuance — diagnostic only (which device / app
   * created this token). Stored truncated to keep the row light.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;
}
