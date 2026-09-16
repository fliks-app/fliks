import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { LiveTvChannelStream } from './livetv-channel-stream.entity';

export type GuideMatchKind = 'id' | 'name' | 'fuzzy' | 'manual';

/**
 * What a user zaps through. Decoupled from the provider entry so a playlist
 * reshuffle or a second source never renumbers the lineup.
 */
@Entity('livetv_channels')
export class LiveTvChannel extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'int', nullable: true, default: null })
  number: number | null;

  /** Local API path once cached, the provider URL until then. */
  @Column({ type: 'text', nullable: true, default: null })
  logoPath: string | null;

  @Index('IDX_livetv_channels_group')
  @Column({ type: 'varchar', nullable: true, default: null })
  groupName: string | null;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ type: 'int', default: 0 })
  sortIndex: number;

  /** The XMLTV `channel id` this is matched to. */
  @Index('IDX_livetv_channels_guide')
  @Column({ type: 'varchar', nullable: true, default: null })
  guideChannelId: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  guideMatchKind: GuideMatchKind | null;

  /** Some guides are published against another timezone than the channel airs in. */
  @Column({ type: 'int', default: 0 })
  guideShiftMinutes: number;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastPlayedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastErrorAt: Date | null;

  @Column({ type: 'int', default: 0 })
  consecutiveFailures: number;

  @OneToMany(() => LiveTvChannelStream, (s) => s.channel)
  streams: LiveTvChannelStream[];
}
