import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import type { PluginManifest, PluginScope } from '../../../common/plugin-contract';

/** Per-install runtime grants — one row per installed plugin. */
@Entity('plugin_registrations')
export class PluginRegistration extends BaseEntity {
  @Column({ unique: true })
  pluginId: string;

  /** Allowlist `library.ingest` paths are checked against; manifest-derived, re-read at every activation. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  ingestRoots: string[];

  /** Scopes consented to at install, a subset of the manifest's declared `scopes`. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  scopes: PluginScope[];

  /** Cached for `GET /api/plugins/ui`; refreshed at hello, manual refresh, and the plugin's own notify. */
  @Column({ type: 'jsonb' })
  manifest: PluginManifest;
}
