import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * One device's standing permission for one account to control it.
 *
 * A row is born as an unclaimed code shown on the device, and becomes a grant
 * when someone enters that code. Proximity is the proof: reading the code means
 * being in front of the screen, which no network-level signal can establish.
 *
 * Keyed by `deviceId`, not by a pair of accounts: granting a television says
 * nothing about its owner's phone.
 */
@Entity('remote_control_grants')
export class RemoteControlGrant extends BaseEntity {
  /** Short, eye-readable code displayed on the device. Cleared once claimed, so
   *  a code can never be reused to reach an established grant. */
  @Column({ type: 'varchar', length: 12, nullable: true })
  @Index()
  code: string | null;

  /** Stable per-installation id of the device being granted. */
  @Column()
  @Index()
  deviceId: string;

  /** The account the device is signed into: the one offering control. */
  @Column()
  @Index()
  ownerUserId: number;

  /** The account allowed to control it; null while the code is unclaimed. */
  @Column({ type: 'int', nullable: true })
  @Index()
  granteeUserId: number | null;

  /** Label shown in both revocation lists. */
  @Column()
  deviceName: string;

  /** Only the code expires. A claimed grant stands until it is revoked. */
  @Column({ type: 'timestamptz' })
  codeExpiresAt: Date;
}
