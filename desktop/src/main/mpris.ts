import dbus from 'dbus-next';
import type { DesktopMediaMetadata, DesktopPositionInfo } from '../shared/contract';

const { Variant } = dbus;
const { Interface } = dbus.interface;
// dbus-next's typings omit configureMembers, the decorator-free way to declare members.
const configure = (cls: unknown, members: object) => (cls as { configureMembers(m: object): void }).configureMembers(members);
const BUS_NAME = 'org.mpris.MediaPlayer2.fliks';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

type Status = 'Playing' | 'Paused' | 'Stopped';

class Root extends Interface {
  [k: string]: any;
  constructor() {
    super('org.mpris.MediaPlayer2');
    this.CanQuit = false;
    this.CanRaise = false;
    this.HasTrackList = false;
    this.Identity = 'Fliks';
    this.DesktopEntry = 'fliks';
    this.SupportedUriSchemes = [];
    this.SupportedMimeTypes = [];
  }
  Raise(): void {}
  Quit(): void {}
}
configure(Root, {
  properties: {
    CanQuit: { signature: 'b', access: 'read' },
    CanRaise: { signature: 'b', access: 'read' },
    HasTrackList: { signature: 'b', access: 'read' },
    Identity: { signature: 's', access: 'read' },
    DesktopEntry: { signature: 's', access: 'read' },
    SupportedUriSchemes: { signature: 'as', access: 'read' },
    SupportedMimeTypes: { signature: 'as', access: 'read' },
  },
  methods: { Raise: {}, Quit: {} },
});

const TRACK_ID = '/org/fliks/track/current';
const micros = (seconds: number) => Math.round(seconds * 1e6);

class Player extends Interface {
  [k: string]: any;
  private readonly key: (name: string) => void;
  private readonly seekTo: (seconds: number) => void;
  lengthUs = 0;
  constructor(key: (name: string) => void, seekTo: (seconds: number) => void) {
    super('org.mpris.MediaPlayer2.Player');
    this.key = key;
    this.seekTo = seekTo;
    this.PlaybackStatus = 'Stopped' as Status;
    this.Metadata = {};
    this.Rate = 1;
    this.MinimumRate = 0.25;
    this.MaximumRate = 2;
    this.Position = 0;
    this.CanGoNext = true;
    this.CanGoPrevious = true;
    this.CanPlay = true;
    this.CanPause = true;
    this.CanSeek = true;
    this.CanControl = true;
  }
  // Electron key codes have no play-only or pause-only key: toggle only when the state differs.
  Play(): void { if (this.PlaybackStatus !== 'Playing') this.key('MediaPlayPause'); }
  Pause(): void { if (this.PlaybackStatus === 'Playing') this.key('MediaPlayPause'); }
  PlayPause(): void { this.key('MediaPlayPause'); }
  Stop(): void { this.key('MediaStop'); }
  Next(): void { this.key('MediaNextTrack'); }
  Previous(): void { this.key('MediaPreviousTrack'); }
  // Both go through the page's seek, not mpv: a transcode seek has to renegotiate.
  Seek(offsetUs: bigint | number): void {
    this.target(Number(this.Position) + Number(offsetUs));
  }
  SetPosition(trackId: string, positionUs: bigint | number): void {
    if (trackId === TRACK_ID) this.target(Number(positionUs));
  }
  Seeked(positionUs: number): number { return positionUs; }
  private target(us: number): void {
    const max = this.lengthUs || Infinity;
    this.seekTo(Math.max(0, Math.min(us, max)) / 1e6);
  }
}
const READ = { access: 'read' };
configure(Player, {
  properties: {
    PlaybackStatus: { signature: 's', ...READ },
    Metadata: { signature: 'a{sv}', ...READ },
    Rate: { signature: 'd', ...READ },
    MinimumRate: { signature: 'd', ...READ },
    MaximumRate: { signature: 'd', ...READ },
    Position: { signature: 'x', ...READ },
    CanGoNext: { signature: 'b', ...READ },
    CanGoPrevious: { signature: 'b', ...READ },
    CanPlay: { signature: 'b', ...READ },
    CanPause: { signature: 'b', ...READ },
    CanSeek: { signature: 'b', ...READ },
    CanControl: { signature: 'b', ...READ },
  },
  methods: {
    Play: {}, Pause: {}, PlayPause: {}, Stop: {}, Next: {}, Previous: {},
    Seek: { inSignature: 'x' },
    SetPosition: { inSignature: 'ox' },
  },
  signals: { Seeked: { signature: 'x' } },
});

/** The OS extrapolates the position from the rate: only a jump past this needs a Seeked. */
const DRIFT_SECONDS = 3;

/** MPRIS on the session bus, so the desktop's media keys and flyout reach Fliks. `onKey` gets the
 *  media key the action stands for, the same one the player's keyboard handler already maps; `onSeek`
 *  a position in seconds the page should seek to. */
export class Mpris {
  private bus: ReturnType<typeof dbus.sessionBus> | null = null;
  private readonly player: Player;
  private owned = false;

  private meta: DesktopMediaMetadata | null = null;
  private seconds = 0;
  private playing = false;
  private rate = 1;
  private lastAt = Date.now();

  constructor(onKey: (name: string) => void, onSeek: (seconds: number) => void) {
    this.player = new Player(onKey, onSeek);
  }

  /** Publishes the session on first use; null withdraws it. */
  async setMetadata(meta: DesktopMediaMetadata | null): Promise<void> {
    if (!meta) return this.withdraw();
    await this.ensureOwned();
    this.meta = meta;
    this.publishMetadata();
  }

  setStatus(status: Status): void {
    if (this.player.PlaybackStatus === status) return;
    this.player.PlaybackStatus = status;
    this.playing = status === 'Playing';
    if (this.owned) Interface.emitPropertiesChanged(this.player, { PlaybackStatus: status }, []);
  }

  setRate(rate: number): void {
    if (this.rate === rate) return;
    this.rate = rate;
    this.player.Rate = rate;
    if (this.owned) Interface.emitPropertiesChanged(this.player, { Rate: rate }, []);
  }

  /** Clients read Position on demand; Seeked tells them when it jumped past their extrapolation. */
  setPosition({ position, duration }: DesktopPositionInfo): void {
    const expected = this.seconds + (this.playing ? ((Date.now() - this.lastAt) / 1000) * this.rate : 0);
    const jumped = Math.abs(position - expected) > DRIFT_SECONDS;
    this.seconds = position;
    this.lastAt = Date.now();
    this.player.Position = micros(position);
    if (jumped && this.owned) this.player.Seeked(micros(position));
    if (micros(duration) !== this.player.lengthUs) {
      this.player.lengthUs = micros(duration);
      if (this.meta && this.owned) this.publishMetadata();
    }
  }

  private publishMetadata(): void {
    const meta = this.meta;
    if (!meta) return;
    const m: Record<string, InstanceType<typeof Variant>> = {
      'mpris:trackid': new Variant('o', TRACK_ID),
      'xesam:title': new Variant('s', meta.title),
    };
    if (meta.artist) m['xesam:artist'] = new Variant('as', [meta.artist]);
    if (meta.artworkUrl) m['mpris:artUrl'] = new Variant('s', meta.artworkUrl);
    if (this.player.lengthUs > 0) m['mpris:length'] = new Variant('x', this.player.lengthUs);
    this.player.Metadata = m;
    Interface.emitPropertiesChanged(this.player, { Metadata: m }, []);
  }

  private async ensureOwned(): Promise<void> {
    if (this.owned) return;
    if (!this.bus) {
      this.bus = dbus.sessionBus();
      this.bus.on('error', (e: Error) => console.error('[mpris] bus error', e.message));
    }
    this.bus.export(OBJECT_PATH, new Root());
    this.bus.export(OBJECT_PATH, this.player);
    await this.bus.requestName(BUS_NAME, 0);
    this.owned = true;
  }

  private async withdraw(): Promise<void> {
    if (!this.owned || !this.bus) return;
    this.owned = false;
    this.player.PlaybackStatus = 'Stopped';
    this.player.Metadata = {};
    this.meta = null;
    this.player.lengthUs = 0;
    this.bus.disconnect();
    this.bus = null;
  }
}
