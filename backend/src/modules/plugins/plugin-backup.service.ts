import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginDatabaseService } from './plugin-database.service';
import { PluginInstallException } from './plugin-install.exception';
import { SettingsService } from '../settings/settings.service';

const EXPORT_FORMAT_VERSION = 1;

export interface PluginExportDocument {
  formatVersion: 1;
  pluginId: string;
  pluginVersion: string;
  exportedAt: string;
  /** Every `plugin.<id>.*` setting this plugin owns, secrets included — a credential-bearing document. */
  settings: Record<string, string | null>;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface PluginImportResult {
  pluginId: string;
  tablesRestored: Record<string, number>;
  settingsRestored: number;
}

/** Structural check only — a malformed document throws 400 rather than reaching SQL or the
 *  settings store with the wrong shape. */
function assertExportDocumentShape(document: unknown): PluginExportDocument {
  const bad = (): never => {
    throw new PluginInstallException(HttpStatus.BAD_REQUEST, 'PLUGIN_EXPORT_MALFORMED', 'not a recognisable plugin export document');
  };
  if (typeof document !== 'object' || document === null) bad();
  const doc = document as Record<string, unknown>;
  if (doc.formatVersion !== EXPORT_FORMAT_VERSION) bad();
  if (typeof doc.pluginId !== 'string' || typeof doc.pluginVersion !== 'string') bad();
  if (typeof doc.settings !== 'object' || doc.settings === null) bad();
  if (typeof doc.tables !== 'object' || doc.tables === null) bad();
  for (const value of Object.values(doc.settings as Record<string, unknown>)) {
    if (value !== null && typeof value !== 'string') bad();
  }
  for (const rows of Object.values(doc.tables as Record<string, unknown>)) {
    if (!Array.isArray(rows)) bad();
  }
  return doc as unknown as PluginExportDocument;
}

/**
 * Exports and restores one plugin's state: its `plugin.<id>.*` settings and every row of its
 * own schema. Data only — a plugin's schema DDL comes from its own migrations, never from this
 * document.
 */
@Injectable()
export class PluginBackupService {
  constructor(
    @InjectRepository(PluginPackage) private readonly packageRepo: Repository<PluginPackage>,
    private readonly pluginDb: PluginDatabaseService,
    private readonly settings: SettingsService,
  ) {}

  async exportPlugin(pluginId: string): Promise<PluginExportDocument> {
    const pkg = await this.findInstalled(pluginId);
    const tables = pkg.manifest.kind === 'process' && pkg.manifest.database.schema ? await this.pluginDb.exportSchemaRows(pluginId) : {};

    return {
      formatVersion: EXPORT_FORMAT_VERSION,
      pluginId,
      pluginVersion: pkg.version,
      exportedAt: new Date().toISOString(),
      settings: await this.collectSettings(pluginId),
      tables,
    };
  }

  /**
   * Refuses rather than merges. A version mismatch means the schema this document describes may
   * not be the schema installed today — there is no migration-diff engine here to reconcile the
   * two — so the operator installs the matching version first. Rows already present in the
   * schema are refused for the same reason: a partial merge on top of existing data would look
   * like a complete restore without being one.
   */
  async importPlugin(pluginId: string, document: unknown): Promise<PluginImportResult> {
    const doc = assertExportDocumentShape(document);
    if (doc.pluginId !== pluginId) {
      throw new PluginInstallException(HttpStatus.BAD_REQUEST, 'PLUGIN_EXPORT_ID_MISMATCH', `export is for "${doc.pluginId}", not "${pluginId}"`);
    }

    const pkg = await this.findInstalled(pluginId);
    if (pkg.status !== 'active') {
      throw new PluginInstallException(
        HttpStatus.CONFLICT,
        'PLUGIN_NOT_READY',
        `plugin "${pluginId}" has not completed activation — its schema may not be migrated yet`,
      );
    }
    if (doc.pluginVersion !== pkg.version) {
      throw new PluginInstallException(
        HttpStatus.CONFLICT,
        'PLUGIN_EXPORT_VERSION_MISMATCH',
        `export is from version ${doc.pluginVersion}, installed version is ${pkg.version} — install ${doc.pluginVersion} before importing`,
      );
    }

    const hasSchema = pkg.manifest.kind === 'process' && pkg.manifest.database.schema;
    if (hasSchema && (await this.pluginDb.schemaHasRows(pluginId))) {
      throw new PluginInstallException(
        HttpStatus.CONFLICT,
        'PLUGIN_SCHEMA_NOT_EMPTY',
        `plugin "${pluginId}" already has rows in its schema — uninstall and reinstall it before importing`,
      );
    }

    if (hasSchema) {
      await this.pluginDb.restoreSchemaRows(pluginId, doc.tables);
    } else if (Object.keys(doc.tables).length) {
      throw new PluginInstallException(
        HttpStatus.CONFLICT,
        'PLUGIN_EXPORT_HAS_NO_SCHEMA',
        `export carries table rows but plugin "${pluginId}" declares no schema to restore them into`,
      );
    }
    const settingsRestored = await this.restoreSettings(pluginId, doc.settings);

    return {
      pluginId,
      tablesRestored: hasSchema
        ? Object.fromEntries(Object.entries(doc.tables).map(([table, rows]) => [table, rows.length]))
        : {},
      settingsRestored,
    };
  }

  private async findInstalled(pluginId: string): Promise<PluginPackage> {
    const pkg = await this.packageRepo.findOne({ where: { pluginId } });
    if (!pkg) throw new PluginInstallException(HttpStatus.NOT_FOUND, 'PLUGIN_NOT_FOUND', `plugin "${pluginId}" is not installed`);
    return pkg;
  }

  /** Same dotted-prefix collision guard as uninstall's settings wipe: a more specific installed
   *  id's keys are never swept into a shorter id's export. */
  private async collectSettings(pluginId: string): Promise<Record<string, string | null>> {
    const prefix = `plugin.${pluginId}.`;
    const others = (await this.packageRepo.find()).map((p) => `plugin.${p.pluginId}.`).filter((p) => p !== prefix && p.startsWith(prefix));
    const all = await this.settings.getAll();
    const out: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(prefix)) continue;
      if (others.some((p) => key.startsWith(p))) continue;
      out[key] = value;
    }
    return out;
  }

  /** Every key must sit under this plugin's own namespace — a document doctored to carry another
   *  plugin's (or core's) setting key is refused rather than written. */
  private async restoreSettings(pluginId: string, settings: Record<string, string | null>): Promise<number> {
    const prefix = `plugin.${pluginId}.`;
    // Every key is checked before any is written: a refusal half-way would leave the plugin
    // configured from two different exports.
    for (const key of Object.keys(settings)) {
      if (!key.startsWith(prefix)) {
        throw new PluginInstallException(HttpStatus.BAD_REQUEST, 'PLUGIN_EXPORT_SETTING_OUT_OF_SCOPE', `setting ${JSON.stringify(key)} is outside plugin "${pluginId}"'s namespace`);
      }
    }
    let count = 0;
    for (const [key, value] of Object.entries(settings)) {
      await this.settings.set(key, value, `plugin-import:${pluginId}`);
      count++;
    }
    return count;
  }
}
