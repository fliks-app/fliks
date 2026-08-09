import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import axios from 'axios';
import * as dns from 'dns';
import { EventsService, type DomainEvent } from '../scheduler/events.service';
import { PluginRegistryService } from './plugin-registry.service';
import { isInternalAddress } from './internal-address';

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
  private async deliver(pluginId: string, webhook: string, event: DomainEvent): Promise<void> {
    let hostname: string;
    try {
      hostname = new URL(webhook).hostname;
    } catch {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — "${webhook}" no longer parses as a URL`);
      return;
    }

    let addresses: string[];
    try {
      addresses = (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);
    } catch (err) {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — DNS lookup failed for "${hostname}": ${(err as Error).message}`);
      return;
    }
    const internal = addresses.find(isInternalAddress);
    if (internal) {
      this.logger.warn(`plugin "${pluginId}" webhook skipped — "${hostname}" resolves to internal address ${internal}`);
      return;
    }

    try {
      await axios.post(
        webhook,
        { event, pluginId },
        {
          timeout: WEBHOOK_TIMEOUT_MS,
          maxRedirects: 0,
          maxContentLength: WEBHOOK_MAX_RESPONSE_BYTES,
          headers: { 'User-Agent': 'Fliks-Plugin-Webhook/1.0', 'Content-Type': 'application/json' },
        },
      );
    } catch (err) {
      this.logger.warn(`plugin "${pluginId}" webhook delivery failed: ${(err as Error).message}`);
    }
  }
}
