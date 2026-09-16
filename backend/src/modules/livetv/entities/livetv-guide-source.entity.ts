import { Entity, Column, ManyToOne, JoinColumn, RelationId } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { LiveTvSource } from './livetv-source.entity';
import type { LiveTvSyncStatus } from './livetv-source.entity';

/** `source` reads the guide the provider already exposes, `xmltv` fetches a URL. */
export type GuideSourceKind = 'xmltv' | 'source';

@Entity('livetv_guide_sources')
export class LiveTvGuideSource extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'varchar', length: 16, default: 'xmltv' })
  kind: GuideSourceKind;

  @Column({ type: 'text', nullable: true, default: null })
  url: string | null;

  @ManyToOne(() => LiveTvSource, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sourceId' })
  source: LiveTvSource | null;

  @RelationId((g: LiveTvGuideSource) => g.source)
  sourceId: number | null;

  @Column({ type: 'int', default: 12 })
  refreshIntervalHours: number;

  /** Applied to every programme of this feed, on top of the per-channel shift. */
  @Column({ type: 'int', default: 0 })
  timezoneOffsetMinutes: number;

  /** BCP-47ish tag matched against a programme's `<title lang="...">`. Null
   *  means no preference: fall back to the untagged title, then the first. */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  language: string | null;

  /** Higher wins when this feed and another both define the same channel id. */
  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastSyncAt: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'never' })
  lastSyncStatus: LiveTvSyncStatus;

  @Column({ type: 'text', nullable: true, default: null })
  lastSyncError: string | null;

  @Column({ type: 'int', default: 0 })
  programCount: number;

  /** Conditional-request validators from the last successful fetch, so an
   *  unchanged feed answers 304 instead of being re-parsed for nothing. */
  @Column({ type: 'varchar', nullable: true, default: null })
  etag: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  lastModified: string | null;
}
