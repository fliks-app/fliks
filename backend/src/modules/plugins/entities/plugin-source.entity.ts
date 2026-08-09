import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** A configured catalog source (an admin-added URL); the official one is just the seeded first row. */
@Entity('plugin_sources')
export class PluginSource extends BaseEntity {
  /** The `catalog.json` URL itself — not a directory. The signature is fetched from `${url}.sig`. */
  @Column()
  url: string;

  @Column({ default: true })
  enabled: boolean;

  /** Verifies this source's signed `catalog.json`; null defers to the compiled-in official key. */
  @Column({ type: 'bytea', nullable: true })
  publicKey: Buffer | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastRefreshedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastRefreshError: string | null;

  /** Opaque — the signed `catalog.json` shape isn't defined until the catalog-client phase. */
  @Column({ type: 'jsonb', nullable: true })
  cachedCatalog: Record<string, unknown> | null;
}
