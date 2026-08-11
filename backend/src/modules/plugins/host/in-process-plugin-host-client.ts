import { Injectable } from '@nestjs/common';
import type { PluginHostApi } from '../../../common/plugin-contract';
import { FliksHostImpl } from './fliks-host.service';

/**
 * A caller's view of the 17 host methods, exactly as a `process` plugin's
 * socket client will see them. Today it forwards straight into
 * `FliksHostImpl` in-process; Phase 10.4 replaces the body of every method
 * here with an `RpcChannel.call(...)` and nothing on the caller side changes.
 */
@Injectable()
export class InProcessPluginHostClient implements PluginHostApi {
  constructor(private readonly host: FliksHostImpl) {}

  'media.acquisitionContext': PluginHostApi['media.acquisitionContext'] = (p) =>
    this.host['media.acquisitionContext'](p);
  'acquisition.candidates': PluginHostApi['acquisition.candidates'] = (p) =>
    this.host['acquisition.candidates'](p);
  'releases.match': PluginHostApi['releases.match'] = (p) =>
    this.host['releases.match'](p);
  'releases.score': PluginHostApi['releases.score'] = (p) =>
    this.host['releases.score'](p);
  'media.resolve': PluginHostApi['media.resolve'] = (p) =>
    this.host['media.resolve'](p);
  'media.exists': PluginHostApi['media.exists'] = (p) =>
    this.host['media.exists'](p);
  'blocklist.add': PluginHostApi['blocklist.add'] = (p) =>
    this.host['blocklist.add'](p);
  'blocklist.check': PluginHostApi['blocklist.check'] = (p) =>
    this.host['blocklist.check'](p);
  'requests.markInProgress': PluginHostApi['requests.markInProgress'] = (p) =>
    this.host['requests.markInProgress'](p);
  'library.ingest': PluginHostApi['library.ingest'] = (p) =>
    this.host['library.ingest'](p);
  'events.publish': PluginHostApi['events.publish'] = (p) =>
    this.host['events.publish'](p);
  'notifications.dispatch': PluginHostApi['notifications.dispatch'] = (p) =>
    this.host['notifications.dispatch'](p);
  'counts.set': PluginHostApi['counts.set'] = (p) => this.host['counts.set'](p);
  'events.emitOwn': PluginHostApi['events.emitOwn'] = (p) =>
    this.host['events.emitOwn'](p);
  'progress.set': PluginHostApi['progress.set'] = (p) =>
    this.host['progress.set'](p);
  'config.get': PluginHostApi['config.get'] = (p) => this.host['config.get'](p);
  'config.set': PluginHostApi['config.set'] = (p) => this.host['config.set'](p);
}
