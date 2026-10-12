import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { QoeEvent, QoeEventType, StallCauseData } from '../core/types';
import { PlaybackQoeSession } from './playback-qoe-session.entity';

@Entity('playback_qoe_events')
@Index('IDX_playback_qoe_events_session', ['sessionId'])
export class PlaybackQoeEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 64 })
  sessionId: string;

  @ManyToOne(() => PlaybackQoeSession, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'sessionId',
    foreignKeyConstraintName: 'FK_playback_qoe_events_session',
  })
  session?: PlaybackQoeSession;

  /** Client clock. */
  @Column({ type: 'timestamptz' })
  at: Date;

  @Column({ type: 'varchar' })
  type: QoeEventType;

  /** The event minus `type` and `at`, plus the server's cause for a stall. */
  @Column({ type: 'jsonb', default: () => `'{}'` })
  data: Omit<QoeEvent, 'type' | 'at'> & Partial<StallCauseData>;
}
