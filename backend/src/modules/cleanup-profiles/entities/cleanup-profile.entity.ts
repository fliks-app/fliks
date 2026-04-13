import { Entity, Column, PrimaryColumn } from 'typeorm';
import type { StalledCleanupProfileKey } from '../../../common/constants/stalled-cleanup-profiles';

@Entity('cleanup_profiles')
export class CleanupProfile {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  key: StalledCleanupProfileKey;

  /** Number of consecutive snapshots that must match to flag a download as stalled. */
  @Column({ type: 'int' })
  samples: number;

  /** Minutes between two snapshots for this profile. */
  @Column({ type: 'int' })
  intervalMinutes: number;

  /** If true, removed torrents trigger an automatic re-search / re-grab. */
  @Column({ type: 'boolean', default: true })
  autoRestart: boolean;
}
