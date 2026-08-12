import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import axios from 'axios';
import * as dns from 'dns';
import { EventsService, type DomainEvent } from '../scheduler/events.service';
import { PluginRegistryService } from './plugin-registry.service';
import { isInternalAddress } from './internal-address';
import { SettingsService } from '../settings/settings.service';
import { WEBHOOK_SETTING_PREFIX } from '../../common/plugin-contract';

/** What the admin page shows after a test: whether an endpoint is configured at all, how many
 *  answered, and what the ones that did not said. */
export interface WebhookTestResult {
  configured: boolean;
  delivered: number;
  failures: string[];
}

const WEBHOOK_TIMEOUT_MS = 5_000;
/** Core never reads the body — cap it so a hostile endpoint can't hold the connection streaming data. */
const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Fans a domain event out to every `data` plugin webhook subscribed to it.
 * Mirrors `EventsService.onDomain`'s at-most-once/no-retry contract: a slow or
 * failing webhook is logged and never reaches the emitter.
 */
@Injectable()
export class PluginWebhookDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PluginWebhookDispatcherService.name);
  private readonly subscription = new Subscription();

  constructor(
    private readonly events: EventsService,
    private readonly registry: PluginRegistryService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.subscription.add(this.events.onDomain((event) => this.dispatch(event)));
  }

  onModuleDestroy(): void {
    this.subscription.unsubscribe();
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const targets = this.registry.listWebhooksForEvent(event.type);
    await Promise.allSettled(targets.map((t) => this.deliver(t.pluginId, t.webhook, event)));
  }

  /**
   * Re-resolves and re-checks the host on every delivery, not only at registration — a
   * name that validated at install can repoint later (DNS rebinding). This narrows but
   * does not eliminate the attack: the HTTP client below re-resolves the same name to
   * actually connect, leaving a window between this check and its connect().
   */
  /** `setting:<key>` reads `plugin.<id>.<key>`; an operator who hasn't filled it in yet has no
   *  endpoint, which is a normal state and not a failure to report. */
  private async resolveTarget(pluginId: string, webhook: string): Promise<string | null> {
    if (!webhook.startsWith(WEBHOOK_SETTING_PREFIX)) return webhook;
    const key = `plugin.${pluginId}.${webhook.slice(WEBHOOK_SETTING_PREFIX.length)}`;
    const value = (await this.settings.get(key))?.trim();
    return value ? value : null;
  }

  private async deliver(pluginId: string, declared: string, event: DomainEvent): Promise<void> {
    const webhook = await this.resolveTarget(pluginId, declared);
    if (!webhook) return;
    if (!(await this.isDeliverable(pluginId, webhook))) return;
    await this.postGuarded(pluginId, webhook, { event, pluginId });
  }

  /** https, parses, and resolves to nothing internal — re-checked on every attempt, because a
   *  name that passed at configuration time can be repointed afterwards. */
  private async isDeliverable(pluginId: string, webhook: string): Promise<boolean> {
    if (!webhook.startsWith('https://')) {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — configured endpoint is not https`);
      return false;
    }
    let hostname: string;
    try {
      hostname = new URL(webhook).hostname;
    } catch {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — "${webhook}" no longer parses as a URL`);
      return false;
    }

    let addresses: string[];
    try {
      addresses = (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);
    } catch (err) {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — DNS lookup failed for "${hostname}": ${(err as Error).message}`);
      return false;
    }
    const internal = addresses.find(isInternalAddress);
    if (internal) {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — "${hostname}" resolves to internal address ${internal}`);
      return false;
    }
    return true;
  }

  /** Resolves, re-checks and posts. The guards — https, no internal address, DNS re-resolved on
   *  every attempt — are the point of routing every delivery through here. */
  private async postGuarded(pluginId: string, webhook: string, body: unknown): Promise<{ ok: boolean; detail?: string }> {
    try {
      await axios.post(
        webhook,
        body,
        {
          timeout: WEBHOOK_TIMEOUT_MS,
          maxRedirects: 0,
          maxContentLength: WEBHOOK_MAX_RESPONSE_BYTES,
          headers: { 'User-Agent': 'Fliks-Plugin-Webhook/1.0', 'Content-Type': 'application/json' },
        },
      );
      return { ok: true };
    } catch (err) {
      const detail = (err as Error).message;
      this.logger.warn(`plugin "${pluginId}" webhook delivery failed: ${detail}`);
      return { ok: false, detail };
    }
  }

  /**
   * Posts one synthetic event to every webhook this plugin declares, so an operator can prove
   * their endpoint answers before waiting for something real. Same resolution and same guards as
   * a real delivery; `configured: false` means the target setting is still empty.
   */
  async sendTest(pluginId: string): Promise<WebhookTestResult> {
    const targets = this.registry.listWebhooksForPlugin(pluginId);
    const failures: string[] = [];
    let delivered = 0;
    let configured = false;

    for (const declared of targets) {
      const webhook = await this.resolveTarget(pluginId, declared.webhook);
      if (!webhook) continue;
      configured = true;
      if (!(await this.isDeliverable(pluginId, webhook))) {
        failures.push(`${declared.event}: target refused`);
        continue;
      }
      const result = await this.postGuarded(pluginId, webhook, {
        event: { type: 'test.delivery', declaredFor: declared.event },
        pluginId,
        test: true,
      });
      if (result.ok) delivered++;
      else failures.push(`${declared.event}: ${result.detail ?? 'failed'}`);
    }

    return { configured, delivered, failures };
  }
}
