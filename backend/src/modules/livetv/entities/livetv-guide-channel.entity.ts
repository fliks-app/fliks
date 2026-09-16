import { Entity, Column, ManyToOne, JoinColumn, RelationId, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { LiveTvGuideSource } from './livetv-guide-source.entity';

/**
 * The feed's own channel list, persisted so the match pass and the admin
 * picker both survive a restart instead of depending on the last in-memory
 * parse. Replaced wholesale per guide source on every sync.
 */
@Entity('livetv_guide_channels')
@Index('UQ_livetv_guide_channel_source_id', ['guideSource', 'channelId'], {
  unique: true,
})
export class LiveTvGuideChannel extends BaseEntity {
  @ManyToOne(() => LiveTvGuideSource, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guideSourceId' })
  guideSource: LiveTvGuideSource;

  @RelationId((c: LiveTvGuideChannel) => c.guideSource)
  guideSourceId: number;

  /** The XMLTV `channel id`, exactly as the feed spells it. */
  @Column({ type: 'varchar' })
  channelId: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  displayNames: string[];

  @Column({ type: 'text', nullable: true, default: null })
  iconUrl: string | null;
}
