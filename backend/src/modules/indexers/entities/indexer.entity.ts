import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('indexers')
export class Indexer extends BaseEntity {
  @Column()
  name: string;

  @Column()
  implementation: string;

  @Column({ type: 'jsonb', default: {} })
  settings: Record<string, unknown>;

  @Column({ default: true })
  enableRss: boolean;

  @Column({ default: true })
  enableSearch: boolean;

  @Column({ default: 25 })
  priority: number;

  /** Minimum seconds between two consecutive requests to this indexer.
   *  Enforced by `IndexerThrottle` — protects against IP bans from
   *  trackers behind anti-DDoS (Cloudflare etc.) when the search
   *  runner fans out across many medias. */
  @Column({ default: 2 })
  requestDelay: number;

  @Column({ default: true })
  enabled: boolean;

  // Populated by refreshCaps() on create/update; reset when the indexer is saved.
  @Column({ default: false })
  capsMovieSearch: boolean;

  @Column({ default: false })
  capsTvSearch: boolean;

  /** Set to true at runtime when caps claimed support but the typed query
   *  returned a Torznab error and a t=search retry succeeded. Reset to false
   *  on every indexer save so a reconfiguration gets a clean slate. */
  @Column({ default: false })
  capsSearchFallback: boolean;
}
