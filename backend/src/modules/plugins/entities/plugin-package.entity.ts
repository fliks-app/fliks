import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import type { PluginManifest } from '../../../common/plugin-contract';
import type { TrustOutcome } from '../archive/trust-store';

export const PLUGIN_PACKAGE_ORIGINS = ['catalog', 'manual'] as const;
export type PluginPackageOrigin = (typeof PLUGIN_PACKAGE_ORIGINS)[number];

export const PLUGIN_PACKAGE_STATUSES = ['active', 'failed'] as const;
export type PluginPackageStatus = (typeof PLUGIN_PACKAGE_STATUSES)[number];

/** The installed artifact — one row per plugin id, replaced in place on upgrade. */
@Entity('plugin_packages')
export class PluginPackage extends BaseEntity {
  /** Immutable business key; unique so a reinstall upserts rather than duplicates. */
  @Column({ unique: true })
  pluginId: string;

  @Column()
  version: string;

  /** The ZIP bytes, so an install survives an image rebuild and a volume wipe. */
  @Column({ type: 'bytea' })
  archive: Buffer;

  @Column({ type: 'enum', enum: PLUGIN_PACKAGE_ORIGINS })
  origin: PluginPackageOrigin;

  @Column({ type: 'varchar' })
  signature: TrustOutcome;

  @Column({ type: 'varchar', nullable: true })
  verifiedByKeyId: string | null;

  @Column({ type: 'jsonb' })
  manifest: PluginManifest;

  /** Operator on/off switch — independent of `status`, which is an activation outcome, not a choice. */
  @Column({ default: true })
  enabled: boolean;

  /** `failed` on a P4 activation failure; the row (and archive) stand regardless. */
  @Column({ type: 'enum', enum: PLUGIN_PACKAGE_STATUSES, default: 'active' })
  status: PluginPackageStatus;

  /** `PluginRegistrationFailure.reason: detail` when `status` is `failed`; null otherwise. */
  @Column({ type: 'text', nullable: true })
  statusReason: string | null;
}
