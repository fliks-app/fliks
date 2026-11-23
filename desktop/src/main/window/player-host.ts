import { appendLog, redactUrls } from '../log-file.ts';
import { ReloadBudget } from '../renderer-recovery.ts';
import { setPlaybackKeepAwake } from '../power.ts';
import { TypedEmitter } from '../mpv/typed-emitter.ts';
import type { PlayerBackend, PlayerBackendEvents } from '../mpv/player-backend.ts';
import type { DesktopEvent } from '../../shared/contract.ts';
import { forwardPlayerEvents } from './forward-events.ts';

/** The Windows gpu-next probe and the mpv connect can take several seconds on a cold start. */
const READY_TIMEOUT_MS = 20_000;

export interface PlayerHostOptions {
  /** A fresh, not yet started backend. */
  create(): Promise<PlayerBackend>;
  emit(event: DesktopEvent): void;
  onFirstFrame?: () => void;
  /** The backend is a subprocess: one that exits on its own is replaced. */
  respawn: boolean;
}

/** Owns the playback backend of the three platforms: its start (`whenReady`), its replacement after a crash,
 *  and the order it goes down in. Window models stay with the platform. */
export class PlayerHost extends TypedEmitter<Pick<PlayerBackendEvents, 'stateChanged' | 'timeUpdate'>> {
  private backend: PlayerBackend | null = null;
  private ready: Promise<PlayerBackend> | null = null;
  private disposed = false;
  private readonly budget = new ReloadBudget();
  /** Playback stopped: by the renderer (stop IPC), by a renderer crash or by teardown. */
  onStop?: () => void;

  private readonly opts: PlayerHostOptions;

  constructor(opts: PlayerHostOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    this.ready = this.spawn();
  }

  /** The started backend; rejects with the start error, or when the start takes too long. */
  async whenReady(): Promise<PlayerBackend> {
    if (!this.ready) throw new Error('player not started');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('player not ready')), READY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private spawn(): Promise<PlayerBackend> {
    const ready = (async () => {
      const backend = await this.opts.create();
      if (this.disposed) {
        await backend.destroy().catch(() => {});
        throw new Error('player host destroyed');
      }
      forwardPlayerEvents(backend, this.opts.emit, this.opts.onFirstFrame);
      backend.on('stateChanged', (p) => this.emit('stateChanged', p));
      backend.on('timeUpdate', (p) => this.emit('timeUpdate', p));
      backend.on('exit', () => this.onExit(backend));
      try {
        await backend.start();
      } catch (e) {
        await backend.destroy().catch(() => {});
        throw e;
      }
      if (this.disposed) {
        await backend.destroy().catch(() => {});
        throw new Error('player host destroyed');
      }
      this.backend = backend;
      return backend;
    })();
    ready.catch((e) => appendLog(redactUrls(`[player] start failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`)));
    return ready;
  }

  /** Playback stays down until the next `whenReady()`: IPC calls queue behind the replacement. */
  private onExit(dead: PlayerBackend): void {
    if (this.disposed || !this.opts.respawn || this.backend !== dead) return;
    this.backend = null;
    void dead.destroy().catch(() => {});
    if (!this.budget.take()) {
      appendLog('[player] mpv keeps exiting, not restarting it');
      this.ready = Promise.reject(new Error('mpv keeps exiting'));
      this.ready.catch(() => {});
      return;
    }
    appendLog('[player] restarting mpv');
    this.ready = this.spawn();
  }

  /** The window was hidden: the page pauses, which releases the display-sleep lock. */
  windowHidden(): void {
    this.opts.emit({ type: 'windowHidden' });
  }

  async stop(): Promise<void> {
    setPlaybackKeepAwake(false);
    this.onStop?.();
    await this.backend?.stop();
  }

  /** The window teardown follows it: the player goes first, even when its teardown throws. */
  async destroy(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    setPlaybackKeepAwake(false);
    this.onStop?.();
    try {
      await this.backend?.destroy();
    } catch (e) {
      appendLog(redactUrls(`[player] teardown failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`));
    }
    this.backend = null;
  }
}
