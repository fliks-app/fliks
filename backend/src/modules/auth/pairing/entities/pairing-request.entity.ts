import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../../common/entities/base.entity';

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired';

@Entity('pairing_requests')
export class PairingRequest extends BaseEntity {
  /** UUID v4 — the public identifier exposed to the unauthenticated TV client. */
  @Column({ unique: true })
  @Index()
  publicId: string;

  /** User the requesting device wants to log in as (chosen on the user picker). */
  @Column()
  @Index()
  userId: number;

  /** Stable per-installation device ID issued by the TV (UUID in fliks_device_id). */
  @Column()
  @Index()
  deviceId: string;

  /** Human-readable name shown on the phone's pending list ("Sony Bravia X90"). */
  @Column()
  deviceName: string;

  @Column({ type: 'varchar', default: 'pending' })
  status: PairingStatus;

  @Column({ nullable: true })
  approvedByUserId: number;

  /**
   * JWT issued at approval — read once by the requesting device, then nulled
   * to keep the BD-clear-text window minimal.
   */
  @Column({ type: 'text', nullable: true })
  accessToken: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
