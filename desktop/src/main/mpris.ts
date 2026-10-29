import dbus, { defineInterface, Variant } from 'dbus-native';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NowPlayingAddon, NowPlayingNative } from './now-playing';

type NowPlayingInfo = Parameters<NowPlayingNative['setNowPlaying']>[0];

const BUS_NAME = 'org.mpris.MediaPlayer2.fliks';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const TRACK_ID = '/org/fliks/track/current';

type Status = 'Playing' | 'Paused' | 'Stopped';

const micros = (seconds: number) => Math.round(seconds * 1e6);
const readOnly = (type: string, value: unknown) => ({ type, access: 'read' as const, value });
const live = (type: string, get: () => unknown) => ({ type, access: 'read' as const, get });

const createRoot = () => defineInterface({
  name: 'org.mpris.MediaPlayer2',
  methods: { Raise: () => {}, Quit: () => {} },
  properties: {
    CanQuit: readOnly('b', false),
    CanRaise: readOnly('b', false),
    HasTrackList: readOnly('b', false),
    Identity: readOnly('s', 'Fliks'),
    DesktopEntry: readOnly('s', 'fliks'),
    SupportedUriSchemes: readOnly('as', []),
    SupportedMimeTypes: readOnly('as', []),
  },
});

/** MPRIS on the session bus, with the shape of a NowPlaying native backend: the desktop's media keys
 *  and flyout reach Fliks through onRemoteCommand. The session is owned from the first push to the clear. */
export class Mpris implements NowPlayingAddon {
  private bus: ReturnType<typeof dbus.sessionBus> | null = null;
  private player: ReturnType<typeof defineInterface> | null = null;
  private owned = false;
  private queue: Promise<void> = Promise.resolve();
  private onCommand: (name: string, position?: number) => void = () => {};

  private status: Status = 'Stopped';
  private metadata: Record<string, Variant> = {};
  private rate = 1;
  private lengthUs = 0;
  private elapsed = 0;
  private pushedAt = Date.now();
  private artFile: string | null = null;

  onRemoteCommand(cb: (name: string, position?: number) => void): void {
    this.onCommand = cb;
  }

  setNowPlaying(info: NowPlayingInfo): void {
    this.enqueue(() => this.publish(info));
  }

  clearNowPlaying(): void {
    this.enqueue(() => this.withdraw());
  }

  /** Pushes are ordered: the bus is asynchronous and a stale publish must not follow a clear. */
  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(op).catch((e) => console.error('[mpris] unavailable', e));
  }

  private async publish(info: NowPlayingInfo): Promise<void> {
    await this.ensureOwned();
    const status: Status = info.playing ? 'Playing' : 'Paused';
    const unchanged = status === this.status && info.rate === this.rate;
    const props: Record<string, unknown> = {};
    if (!unchanged) {
      this.status = status;
      this.rate = info.rate;
      props.PlaybackStatus = status;
      props.Rate = info.rate;
    }
    this.elapsed = info.elapsed;
    this.pushedAt = Date.now();
    this.lengthUs = micros(info.duration);
    if (info.artwork) this.writeArtwork(info.artwork);
    const m: Record<string, Variant> = {
      'mpris:trackid': new Variant('o', TRACK_ID),
      'xesam:title': new Variant('s', info.title),
    };
    if (info.artist) m['xesam:artist'] = new Variant('as', [info.artist]);
    if (this.artFile) m['mpris:artUrl'] = new Variant('s', pathToFileURL(this.artFile).href);
    if (this.lengthUs > 0) m['mpris:length'] = new Variant('x', BigInt(this.lengthUs));
    this.metadata = m;
    props.Metadata = m;
    this.bus?.emitPropertiesChanged(OBJECT_PATH, PLAYER_IFACE, props, []);
    // A push with no status change means the position jumped past the OS's extrapolation.
    if (unchanged) this.player?.emit.Seeked(BigInt(micros(info.elapsed)));
  }

  /** The desktop fetches the artwork itself: hand it a file named by its content. */
  private writeArtwork(bytes: Buffer): void {
    const file = path.join(os.tmpdir(), `fliks-artwork-${createHash('sha1').update(bytes).digest('hex')}`);
    if (file !== this.artFile) {
      fs.writeFileSync(file, bytes);
      this.dropArtwork();
      this.artFile = file;
    }
  }

  private dropArtwork(): void {
    if (this.artFile) fs.rmSync(this.artFile, { force: true });
    this.artFile = null;
  }

  private positionUs(): number {
    const ahead = this.status === 'Playing' ? ((Date.now() - this.pushedAt) / 1000) * this.rate : 0;
    return micros(this.elapsed + ahead);
  }

  private createPlayer() {
    const key = (name: string) => () => this.onCommand(name);
    // Both seeks go through the page, not mpv: a transcode seek has to renegotiate.
    const target = (us: number) =>
      this.onCommand('seek', Math.max(0, Math.min(us, this.lengthUs || Infinity)) / 1e6);
    return defineInterface({
      name: PLAYER_IFACE,
      methods: {
        Play: key('play'),
        Pause: key('pause'),
        PlayPause: key('toggle'),
        Stop: key('stop'),
        Next: key('next'),
        Previous: key('previous'),
        Seek: { in: { offset: 'x' }, handler: ({ offset }) => target(this.positionUs() + Number(offset)) },
        SetPosition: {
          in: { trackId: 'o', position: 'x' },
          handler: ({ trackId, position }) => { if (trackId === TRACK_ID) target(Number(position)); },
        },
      },
      properties: {
        PlaybackStatus: live('s', () => this.status),
        Metadata: live('a{sv}', () => this.metadata),
        Rate: live('d', () => this.rate),
        MinimumRate: readOnly('d', 0.25),
        MaximumRate: readOnly('d', 2),
        Position: live('x', () => BigInt(this.positionUs())),
        CanGoNext: readOnly('b', true),
        CanGoPrevious: readOnly('b', true),
        CanPlay: readOnly('b', true),
        CanPause: readOnly('b', true),
        CanSeek: readOnly('b', true),
        CanControl: readOnly('b', true),
      },
      signals: { Seeked: { args: { position: 'x' } } },
    });
  }

  private async ensureOwned(): Promise<void> {
    if (this.owned) return;
    if (!this.bus) {
      this.bus = dbus.sessionBus();
      this.bus.on('error', (e: Error) => console.error('[mpris] bus error', e.message));
    }
    this.player = this.createPlayer();
    await this.bus.export(OBJECT_PATH, createRoot());
    await this.bus.export(OBJECT_PATH, this.player);
    await this.bus.requestName(BUS_NAME, 0);
    this.owned = true;
  }

  private async withdraw(): Promise<void> {
    if (!this.owned || !this.bus) return;
    this.owned = false;
    this.status = 'Stopped';
    this.metadata = {};
    this.lengthUs = 0;
    this.dropArtwork();
    const bus = this.bus;
    this.bus = null;
    this.player = null;
    await bus.close();
  }
}
