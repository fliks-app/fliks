import dbus, { defineInterface, Variant } from 'dbus-native';
import type { DesktopMediaMetadata, DesktopPositionInfo } from '../shared/contract';

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

/** The OS extrapolates the position from the rate: only a jump past this needs a Seeked. */
const DRIFT_SECONDS = 3;

/** MPRIS on the session bus, so the desktop's media keys and flyout reach Fliks. `onKey` gets the
 *  media key the action stands for, the same one the player's keyboard handler already maps; `onSeek`
 *  a position in seconds the page should seek to. */
export class Mpris {
  private bus: ReturnType<typeof dbus.sessionBus> | null = null;
  private player: ReturnType<typeof defineInterface> | null = null;
  private owned = false;

  private status: Status = 'Stopped';
  private metadata: Record<string, Variant> = {};
  private rate = 1;
  private positionUs = 0;
  private lengthUs = 0;

  private meta: DesktopMediaMetadata | null = null;
  private seconds = 0;
  private lastAt = Date.now();

  constructor(
    private readonly onKey: (name: string) => void,
    private readonly onSeek: (seconds: number) => void,
  ) {}

  /** Publishes the session on first use; null withdraws it. */
  async setMetadata(meta: DesktopMediaMetadata | null): Promise<void> {
    if (!meta) return this.withdraw();
    await this.ensureOwned();
    this.meta = meta;
    this.publishMetadata();
  }

  setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    this.changed({ PlaybackStatus: status });
  }

  setRate(rate: number): void {
    if (this.rate === rate) return;
    this.rate = rate;
    this.changed({ Rate: rate });
  }

  /** Clients read Position on demand; Seeked tells them when it jumped past their extrapolation. */
  setPosition({ position, duration }: DesktopPositionInfo): void {
    const playing = this.status === 'Playing';
    const expected = this.seconds + (playing ? ((Date.now() - this.lastAt) / 1000) * this.rate : 0);
    const jumped = Math.abs(position - expected) > DRIFT_SECONDS;
    this.seconds = position;
    this.lastAt = Date.now();
    this.positionUs = micros(position);
    if (jumped && this.owned) this.player?.emit.Seeked(BigInt(this.positionUs));
    if (micros(duration) !== this.lengthUs) {
      this.lengthUs = micros(duration);
      if (this.meta && this.owned) this.publishMetadata();
    }
  }

  private changed(props: Record<string, unknown>): void {
    if (this.owned) this.bus?.emitPropertiesChanged(OBJECT_PATH, PLAYER_IFACE, props, []);
  }

  private publishMetadata(): void {
    const meta = this.meta;
    if (!meta) return;
    const m: Record<string, Variant> = {
      'mpris:trackid': new Variant('o', TRACK_ID),
      'xesam:title': new Variant('s', meta.title),
    };
    if (meta.artist) m['xesam:artist'] = new Variant('as', [meta.artist]);
    if (meta.artworkUrl) m['mpris:artUrl'] = new Variant('s', meta.artworkUrl);
    if (this.lengthUs > 0) m['mpris:length'] = new Variant('x', BigInt(this.lengthUs));
    this.metadata = m;
    this.changed({ Metadata: m });
  }

  private createPlayer() {
    const key = (name: string) => () => this.onKey(name);
    // Both seeks go through the page, not mpv: a transcode seek has to renegotiate.
    const target = (us: number) =>
      this.onSeek(Math.max(0, Math.min(us, this.lengthUs || Infinity)) / 1e6);
    return defineInterface({
      name: PLAYER_IFACE,
      methods: {
        // Electron key codes have no play-only or pause-only key: toggle only when the state differs.
        Play: () => { if (this.status !== 'Playing') this.onKey('MediaPlayPause'); },
        Pause: () => { if (this.status === 'Playing') this.onKey('MediaPlayPause'); },
        PlayPause: key('MediaPlayPause'),
        Stop: key('MediaStop'),
        Next: key('MediaNextTrack'),
        Previous: key('MediaPreviousTrack'),
        Seek: { in: { offset: 'x' }, handler: ({ offset }) => target(this.positionUs + Number(offset)) },
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
        Position: live('x', () => BigInt(this.positionUs)),
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
    this.meta = null;
    this.lengthUs = 0;
    const bus = this.bus;
    this.bus = null;
    this.player = null;
    await bus.close();
  }
}
