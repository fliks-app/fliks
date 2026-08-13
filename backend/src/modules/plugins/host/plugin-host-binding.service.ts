import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HOST_METHOD_SCOPES, type PluginHostApi } from '../../../common/plugin-contract';
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
    /** Distinct from the "no active registration" message so a plugin (and a test)
     *  can tell an unknown identity apart from a known one refused for this method. */
    const scoped = <T>(method: keyof PluginHostApi, fn: () => Promise<T>): Promise<T> =>
      this.registrations
        .findOne({ where: { pluginId } })
        .then((registration) => {
          if (!registration) {
            throw new Error(`plugin "${pluginId}" has no active registration`);
          }
          const missing = HOST_METHOD_SCOPES[method].filter((s) => !registration.scopes.includes(s));
          if (missing.length) {
            throw new Error(
              `plugin "${pluginId}" is missing scope "${missing[0]}" required for "${method}"`,
            );
          }
          return PluginHostContext.runAs(pluginId, fn);
        });

    return {
      'media.acquisitionContext': (p) =>
        scoped('media.acquisitionContext', () => this.client['media.acquisitionContext'](p)),
      'acquisition.candidates': (p) =>
        scoped('acquisition.candidates', () => this.client['acquisition.candidates'](p)),
      'releases.match': (p) =>
        scoped('releases.match', () => this.client['releases.match'](p)),
      'releases.score': (p) =>
        scoped('releases.score', () => this.client['releases.score'](p)),
      'media.resolve': (p) =>
        scoped('media.resolve', () => this.client['media.resolve'](p)),
      'media.exists': (p) => scoped('media.exists', () => this.client['media.exists'](p)),
      'requests.markInProgress': (p) =>
        scoped('requests.markInProgress', () => this.client['requests.markInProgress'](p)),
      'library.ingest': (p) =>
        scoped('library.ingest', () => this.client['library.ingest'](p)),
      'events.publish': (p) =>
        scoped('events.publish', () => this.client['events.publish'](p)),
      'notifications.dispatch': (p) =>
        scoped('notifications.dispatch', () => this.client['notifications.dispatch'](p)),
      'counts.set': (p) => scoped('counts.set', () => this.client['counts.set'](p)),
      'events.emitOwn': (p) =>
        scoped('events.emitOwn', () => this.client['events.emitOwn'](p)),
      'progress.set': (p) => scoped('progress.set', () => this.client['progress.set'](p)),
      'config.get': (p) => scoped('config.get', () => this.client['config.get'](p)),
      'config.set': (p) => scoped('config.set', () => this.client['config.set'](p)),
    };
  }
}
