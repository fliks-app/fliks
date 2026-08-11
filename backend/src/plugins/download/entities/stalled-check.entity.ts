import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';

/**
 * Snapshot of a torrent's downloaded-byte count at a point in time.
 * Used by the stalled-download cleanup job to detect "no progress over N checks".
 */
@Entity('stalled_checks')
@Index(['torrentHash', 'checkedAt'])
export class StalledCheck {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64 })
  torrentHash: string;

  @Column({ type: 'bigint' })
  downloadedBytes: string;

  @CreateDateColumn()
  checkedAt: Date;
}
