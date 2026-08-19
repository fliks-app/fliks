import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as semver from 'semver';
import { SettingsService } from '../settings/settings.service';
import { PluginInstallService } from './plugin-install.service';
import { PluginPackage } from './entities/plugin-package.entity';
import { PluginSource } from './entities/plugin-source.entity';
import type { FilteredCatalog, FilteredCatalogEntry } from './catalog/catalog';

/** Off unless an admin turned it on: an unattended install is opt-in, never a default. */
export const PLUGIN_AUTO_UPDATE_SETTING = 'plugins.auto_update';

export interface AutoUpdateOutcome {
  updated: { pluginId: string; from: string; to: string }[];
  skipped: { pluginId: string; version: string; reason: string }[];
}

/**
 * Installs a newer catalog version of an already-installed plugin, once a day, after the
 * sources have been refreshed. The cached catalog is stored pre-filtered by core
 * compatibility, so its newest `installable` entry is by construction one this core can run.
 */
@Injectable()
export class PluginAutoUpdateService {
  private readonly log = new Logger(PluginAutoUpdateService.name);

  constructor(
    @InjectRepository(PluginPackage)
    private readonly packageRepo: Repository<PluginPackage>,
    @InjectRepository(PluginSource)
    private readonly sourceRepo: Repository<PluginSource>,
    private readonly settings: SettingsService,
    private readonly installService: PluginInstallService,
  ) {}

  async enabled(): Promise<boolean> {
    return (await this.settings.get(PLUGIN_AUTO_UPDATE_SETTING)) === 'true';
  }

  async run(): Promise<AutoUpdateOutcome> {
    const outcome: AutoUpdateOutcome = { updated: [], skipped: [] };
    if (!(await this.enabled())) return outcome;

    const [installed, sources] = await Promise.all([
      this.packageRepo.find(),
      this.sourceRepo.find({ where: { enabled: true } }),
    ]);

    for (const pkg of installed) {
      const candidate = this.newestFor(pkg.pluginId, sources);
      if (!candidate) continue;
      if (!semver.valid(pkg.version) || !semver.gt(candidate.version, pkg.version)) continue;
      await this.update(pkg, candidate, outcome);
    }

    if (outcome.updated.length || outcome.skipped.length) {
      this.log.log(
        `auto-update: ${outcome.updated.length} updated, ${outcome.skipped.length} skipped`,
      );
    }
    return outcome;
  }

  /** The highest version any enabled source offers, with the source that offers it. */
  private newestFor(
    pluginId: string,
    sources: PluginSource[],
  ): { source: PluginSource; version: string } | null {
    let best: { source: PluginSource; version: string } | null = null;
    for (const source of sources) {
      const catalog = source.cachedCatalog as unknown as FilteredCatalog | null;
      const entry = catalog?.plugins?.find((p: FilteredCatalogEntry) => p.id === pluginId);
      // `filterCatalog` sorts `installable` ascending and drops what this core cannot run.
      const newest = entry?.installable?.at(-1)?.version;
      if (!newest || !semver.valid(newest)) continue;
      if (!best || semver.gt(newest, best.version)) best = { source, version: newest };
    }
    return best;
  }

  private async update(
    pkg: PluginPackage,
    candidate: { source: PluginSource; version: string },
    outcome: AutoUpdateOutcome,
  ): Promise<void> {
    const { pluginId } = pkg;
    const skip = (reason: string) => {
      outcome.skipped.push({ pluginId, version: candidate.version, reason });
      this.log.warn(`auto-update: ${pluginId}@${candidate.version} skipped — ${reason}`);
    };
    try {
      const report = await this.installService.inspectFromCatalog(
        candidate.source,
        pluginId,
        candidate.version,
      );
      if (!report.installable || !report.stagingId || !report.sha256) {
        skip(report.refusalCode ?? 'not installable');
        return;
      }
      // The consent sheet is the only place an unverified archive is acknowledged. An
      // unattended run must never stand in for that acknowledgement, so it installs
      // nothing the catalogue key did not sign. Staging is swept hourly on its own.
      if (report.signature !== 'official') {
        skip(`signature is "${report.signature ?? 'unknown'}", which needs an admin's acknowledgement`);
        return;
      }
      const result = await this.installService.confirmImport({
        stagingId: report.stagingId,
        sha256: report.sha256,
      });
      if (result.status !== 'active') {
        skip(result.reason ?? 'install did not activate');
        return;
      }
      outcome.updated.push({ pluginId, from: pkg.version, to: candidate.version });
      this.log.log(`auto-update: ${pluginId} ${pkg.version} → ${candidate.version}`);
    } catch (err) {
      // One plugin's failure must not stop the others: this runs unattended.
      skip((err as Error).message);
    }
  }
}
