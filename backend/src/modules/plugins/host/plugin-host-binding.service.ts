import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { PluginHostApi } from '../../../common/plugin-contract';
import { PluginRegistration } from '../entities/plugin-registration.entity';
import { InProcessPluginHostClient } from './in-process-plugin-host-client';
import { PluginHostContext } from './plugin-host-context';

/**
 * Builds a `PluginHostApi` scoped to exactly one plugin id — what a
 * per-connection dispatcher hands to a `process` plugin once it has
 * identified which registration the connection belongs to. The id comes
 * from the caller (the connection/registration lookup), never from a
 * method's own payload, so nothing in the 15 methods' params can change it.
 */
@Injectable()
export class PluginHostBindingService {
  constructor(
    @InjectRepository(PluginRegistration)
    private readonly registrations: Repository<PluginRegistration>,
    private readonly client: InProcessPluginHostClient,
  ) {}

  /** Re-checks the registration on every call, not just at bind time, so an
   *  uninstall mid-connection fails the very next call rather than the next spawn.
   *  ponytail: one `findOne` per call, uncached — add a cache invalidated by
   *  `unregister()` if the round trip ever measurably matters. */
  bind(pluginId: string): PluginHostApi {
    const scoped = <T>(fn: () => Promise<T>): Promise<T> =>
      this.registrations
        .findOne({ where: { pluginId } })
        .then((registration) => {
          if (!registration) {
            throw new Error(`plugin "${pluginId}" has no active registration`);
          }
          return PluginHostContext.runAs(pluginId, fn);
        });

    return {
      'media.acquisitionContext': (p) =>
        scoped(() => this.client['media.acquisitionContext'](p)),
      'acquisition.candidates': (p) =>
        scoped(() => this.client['acquisition.candidates'](p)),
      'releases.match': (p) => scoped(() => this.client['releases.match'](p)),
      'releases.score': (p) => scoped(() => this.client['releases.score'](p)),
      'media.resolve': (p) => scoped(() => this.client['media.resolve'](p)),
      'media.exists': (p) => scoped(() => this.client['media.exists'](p)),
      'requests.markInProgress': (p) =>
        scoped(() => this.client['requests.markInProgress'](p)),
      'library.ingest': (p) => scoped(() => this.client['library.ingest'](p)),
      'events.publish': (p) => scoped(() => this.client['events.publish'](p)),
      'notifications.dispatch': (p) =>
        scoped(() => this.client['notifications.dispatch'](p)),
      'counts.set': (p) => scoped(() => this.client['counts.set'](p)),
      'events.emitOwn': (p) => scoped(() => this.client['events.emitOwn'](p)),
      'progress.set': (p) => scoped(() => this.client['progress.set'](p)),
      'config.get': (p) => scoped(() => this.client['config.get'](p)),
      'config.set': (p) => scoped(() => this.client['config.set'](p)),
    };
  }
}
