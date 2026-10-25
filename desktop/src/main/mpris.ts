import dbus from 'dbus-next';
import type { DesktopMediaMetadata } from '../shared/contract';

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

class Player extends Interface {
  [k: string]: any;
  constructor(private readonly key: (name: string) => void) {
    super('org.mpris.MediaPlayer2.Player');
    this.PlaybackStatus = 'Stopped' as Status;
    this.Metadata = {};
    this.Rate = 1;
    this.MinimumRate = 1;
    this.MaximumRate = 1;
    this.Position = 0;
    this.CanGoNext = true;
    this.CanGoPrevious = true;
    this.CanPlay = true;
    this.CanPause = true;
    this.CanSeek = false;
    this.CanControl = true;
  }
  // Electron key codes have no play-only or pause-only key: toggle only when the state differs.
  Play(): void { if (this.PlaybackStatus !== 'Playing') this.key('MediaPlayPause'); }
  Pause(): void { if (this.PlaybackStatus === 'Playing') this.key('MediaPlayPause'); }
  PlayPause(): void { this.key('MediaPlayPause'); }
  Stop(): void { this.key('MediaStop'); }
  Next(): void { this.key('MediaNextTrack'); }
  Previous(): void { this.key('MediaPreviousTrack'); }
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
  methods: { Play: {}, Pause: {}, PlayPause: {}, Stop: {}, Next: {}, Previous: {} },
});

/** MPRIS on the session bus, so the desktop's media keys and flyout reach Fliks. `onKey` gets the
 *  media key the action stands for, the same one the player's keyboard handler already maps. */
export class Mpris {
  private bus: ReturnType<typeof dbus.sessionBus> | null = null;
  private readonly player: Player;
  private owned = false;

  constructor(onKey: (name: string) => void) {
    this.player = new Player(onKey);
  }

  /** Publishes the session on first use; null withdraws it. */
  async setMetadata(meta: DesktopMediaMetadata | null): Promise<void> {
    if (!meta) return this.withdraw();
    await this.ensureOwned();
    const m: Record<string, InstanceType<typeof Variant>> = {
      'mpris:trackid': new Variant('o', '/org/fliks/track/current'),
      'xesam:title': new Variant('s', meta.title),
    };
    if (meta.artist) m['xesam:artist'] = new Variant('as', [meta.artist]);
    if (meta.artworkUrl) m['mpris:artUrl'] = new Variant('s', meta.artworkUrl);
    this.player.Metadata = m;
    Interface.emitPropertiesChanged(this.player, { Metadata: m }, []);
  }

  setStatus(status: Status): void {
    if (this.player.PlaybackStatus === status) return;
    this.player.PlaybackStatus = status;
    if (this.owned) Interface.emitPropertiesChanged(this.player, { PlaybackStatus: status }, []);
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
    this.bus.disconnect();
    this.bus = null;
  }
}
