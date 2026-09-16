import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  RelationId,
  Index,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { LiveTvChannel } from './livetv-channel.entity';
import { LiveTvSource } from './livetv-source.entity';

/** One playable URL behind a channel. Several rows make failover and
 *  cross-source folding the same mechanism. */
@Entity('livetv_channel_streams')
@Index('UQ_livetv_stream_source_external', ['source', 'externalId'], {
  unique: true,
})
export class LiveTvChannelStream extends BaseEntity {
  @ManyToOne(() => LiveTvChannel, (c) => c.streams, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channelId' })
  channel: LiveTvChannel;

  @RelationId((s: LiveTvChannelStream) => s.channel)
  channelId: number;

  @ManyToOne(() => LiveTvSource, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sourceId' })
  source: LiveTvSource;

  @RelationId((s: LiveTvChannelStream) => s.source)
  sourceId: number;

  /** The provider's own id: the natural key a refresh matches on. */
  @Column({ type: 'varchar' })
  externalId: string;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'int', default: 0 })
  priority: number;

  /** Free-form provider label ("FHD", "backup"). */
  @Column({ type: 'varchar', nullable: true, default: null })
  qualityLabel: string | null;

  /** The provider's name for the entry, kept for re-matching and the admin list. */
  @Column({ type: 'varchar' })
  providerName: string;

  /** From the playlist entry's own directives; wins over the source's values. */
  @Column({ type: 'varchar', nullable: true, default: null })
  userAgent: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  referer: string | null;

  /** Stamped on every sync that still sees this stream; a row unseen for too
   *  long is what actually gets deleted, not mere absence from one fetch. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastSeenAt: Date | null;

  /** Filled by a one-off probe on first tune. Null means "not probed yet", and
   *  a remux is never assumed from a null: ffmpeg happily copies MPEG-2 into
   *  fMP4 and no browser decodes the result. */
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  probedVideoCodec: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  probedAudioCodec: string | null;

  /** ffprobe's `format_name`. A playlist container rules out direct play: the
   *  URL describes a stream instead of being one. */
  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  probedContainer: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastOkAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  lastError: string | null;
}
