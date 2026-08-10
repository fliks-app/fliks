import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { Library } from '../libraries/entities/library.entity';
import { QualityProfile } from '../profiles/entities/quality-profile.entity';
import { LanguageProfile } from '../profiles/entities/language-profile.entity';
import { DownloadClient } from '../../plugins/download/download-clients/entities/download-client.entity';
import { Indexer } from '../../plugins/download/indexers/entities/indexer.entity';
import { SubtitleProvider } from '../subtitles/entities/subtitle-provider.entity';
import { NotificationConnection } from '../notifications/entities/notification-connection.entity';
import { User } from '../users/entities/user.entity';
import { AutoApprovalRule } from '../requests/entities/auto-approval-rule.entity';
import { SettingsService } from '../settings/settings.service';

/** Storage key in `app_settings` for the JSON array of dismissed
 *  checklist item keys. Global (not per-user) — Fliks installs
 *  typically have a single admin, so a dismiss-once UX is acceptable
 *  and avoids a join table. */
const DISMISSED_SETTING_KEY = 'setup_checklist_dismissed_keys';

export type ChecklistItemSeverity = 'required' | 'recommended';

export type ChecklistItemKey =
  | 'library'
  | 'quality-profile'
  | 'language-profile'
  | 'download-client'
  | 'indexer'
  | 'subtitle-provider'
  | 'notification'
  | 'non-admin-user'
  | 'auto-approval-rule';

interface ChecklistItemDef {
  key: ChecklistItemKey;
  severity: ChecklistItemSeverity;
  /** Frontend route segments to navigate to when the user clicks
   *  "Configurer". Kept on the backend so adding a new item only
   *  touches one place. */
  route: string[];
  check: () => Promise<boolean>;
}

export interface ChecklistItemStatus {
  key: ChecklistItemKey;
  severity: ChecklistItemSeverity;
  /** True when the underlying condition is satisfied. */
  done: boolean;
  /** True when an admin has explicitly dismissed this item. */
  dismissed: boolean;
  route: string[];
}

@Injectable()
export class SetupChecklistService {
  private readonly log = new Logger(SetupChecklistService.name);

  constructor(
    @InjectRepository(Library)
    private readonly libraryRepo: Repository<Library>,
    @InjectRepository(QualityProfile)
    private readonly qualityProfileRepo: Repository<QualityProfile>,
    @InjectRepository(LanguageProfile)
    private readonly languageProfileRepo: Repository<LanguageProfile>,
    @InjectRepository(DownloadClient)
    private readonly downloadClientRepo: Repository<DownloadClient>,
    @InjectRepository(Indexer)
    private readonly indexerRepo: Repository<Indexer>,
    @InjectRepository(SubtitleProvider)
    private readonly subtitleProviderRepo: Repository<SubtitleProvider>,
    @InjectRepository(NotificationConnection)
    private readonly notificationConnectionRepo: Repository<NotificationConnection>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AutoApprovalRule)
    private readonly autoApprovalRuleRepo: Repository<AutoApprovalRule>,
    private readonly settings: SettingsService,
  ) {}

  /** Single source of truth for checklist items. Adding a new item:
   *  push an entry here, add an i18n key on the frontend, done. */
  private readonly items: ChecklistItemDef[] = [
    {
      key: 'library',
      severity: 'required',
      route: ['/admin', 'settings', 'libraries'],
      check: async () => (await this.libraryRepo.count()) > 0,
    },
    {
      key: 'quality-profile',
      severity: 'required',
      route: ['/admin', 'settings', 'quality-profiles'],
      check: async () => (await this.qualityProfileRepo.count()) > 0,
    },
    {
      key: 'language-profile',
      severity: 'required',
      route: ['/admin', 'settings', 'language-profiles'],
      check: async () => (await this.languageProfileRepo.count()) > 0,
    },
    {
      key: 'download-client',
      severity: 'required',
      route: ['/admin', 'settings', 'download-clients'],
      check: async () =>
        (await this.downloadClientRepo.count({ where: { enabled: true } })) > 0,
    },
    {
      key: 'indexer',
      severity: 'required',
      route: ['/admin', 'settings', 'indexers'],
      check: async () =>
        (await this.indexerRepo.count({ where: { enabled: true } })) > 0,
    },
    {
      key: 'subtitle-provider',
      severity: 'recommended',
      route: ['/admin', 'settings', 'subtitle-providers'],
      check: async () =>
        (await this.subtitleProviderRepo.count({ where: { enabled: true } })) >
        0,
    },
    {
      key: 'notification',
      severity: 'recommended',
      route: ['/admin', 'settings', 'notifications'],
      check: async () => (await this.notificationConnectionRepo.count()) > 0,
    },
    {
      key: 'non-admin-user',
      severity: 'recommended',
      route: ['/admin', 'settings', 'users'],
      check: async () =>
        (await this.userRepo.count({ where: { isAdmin: Not(true) } })) > 0,
    },
    {
      key: 'auto-approval-rule',
      severity: 'recommended',
      route: ['/admin', 'settings', 'auto-approval'],
      check: async () => (await this.autoApprovalRuleRepo.count()) > 0,
    },
  ];

  async getStatus(): Promise<ChecklistItemStatus[]> {
    const dismissed = await this.getDismissedKeys();
    // Run every check in parallel — each one is a single `count()` so
    // hitting them sequentially would needlessly add 9× the round-trip.
    const dones = await Promise.all(
      this.items.map(async (item) => {
        try {
          return await item.check();
        } catch (err) {
          this.log.warn(
            `Checklist item "${item.key}" check failed: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
          return false;
        }
      }),
    );
    return this.items.map((item, i) => ({
      key: item.key,
      severity: item.severity,
      done: dones[i],
      dismissed: dismissed.has(item.key),
      route: item.route,
    }));
  }

  async dismiss(key: ChecklistItemKey): Promise<void> {
    if (!this.isKnownKey(key)) return;
    const dismissed = await this.getDismissedKeys();
    if (dismissed.has(key)) return;
    dismissed.add(key);
    await this.saveDismissedKeys(dismissed);
  }

  async undismiss(key: ChecklistItemKey): Promise<void> {
    const dismissed = await this.getDismissedKeys();
    if (!dismissed.delete(key)) return;
    await this.saveDismissedKeys(dismissed);
  }

  private async getDismissedKeys(): Promise<Set<ChecklistItemKey>> {
    const raw = await this.settings.get(DISMISSED_SETTING_KEY);
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(
        parsed.filter((k): k is ChecklistItemKey =>
          this.isKnownKey(k as string),
        ),
      );
    } catch {
      return new Set();
    }
  }

  private async saveDismissedKeys(
    dismissed: Set<ChecklistItemKey>,
  ): Promise<void> {
    await this.settings.set(DISMISSED_SETTING_KEY, JSON.stringify([...dismissed]));
  }

  private isKnownKey(key: string): key is ChecklistItemKey {
    return this.items.some((i) => i.key === key);
  }
}
