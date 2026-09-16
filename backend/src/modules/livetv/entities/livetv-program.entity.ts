import { Entity, Column, Index, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { LiveTvGuideSource } from './livetv-guide-source.entity';

/**
 * The guide. Deliberately not a `media` row: programmes are ephemeral, they
 * arrive by the hundred thousand, and nothing in the library pipeline
 * (search vector, counts, refresh jobs) should ever walk them.
 *
 * Keyed by the guide's own channel id rather than by a channel row, so a feed
 * can be ingested before, and independently of, the lineup it will match.
 *
 * Scoped to its guide source: two feeds routinely define the same channel id
 * (two mainstream XMLTV namespaces share under 5% of theirs), so a sync must
 * only ever touch its own rows, never a sibling source's.
 */
@Entity('livetv_programs')
@Index('IDX_livetv_programs_channel_start', ['guideChannelId', 'startsAt'])
@Index('IDX_livetv_programs_window', ['startsAt', 'endsAt'])
@Index('IDX_livetv_programs_source_channel_start', [
  'guideSource',
  'guideChannelId',
  'startsAt',
])
export class LiveTvProgram extends BaseEntity {
  @ManyToOne(() => LiveTvGuideSource, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guideSourceId' })
  guideSource: LiveTvGuideSource;

  @RelationId((p: LiveTvProgram) => p.guideSource)
  guideSourceId: number;

  @Column({ type: 'varchar' })
  guideChannelId: string;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  subtitle: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  categories: string[];

  @Column({ type: 'text', nullable: true, default: null })
  iconUrl: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  seasonNumber: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  episodeNumber: number | null;

  /** Stable across airings when the feed provides one: what a series rule matches on. */
  @Column({ type: 'varchar', nullable: true, default: null })
  seriesId: string | null;

  @Column({ type: 'boolean', default: false })
  isNew: boolean;

  @Column({ type: 'boolean', default: false })
  isLive: boolean;

  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  rating: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  year: number | null;
}
