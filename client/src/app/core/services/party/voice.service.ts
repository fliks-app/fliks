import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { TranslateService } from '@ngx-translate/core';
import { PartyApiService, type PartyMember, type PartySignalKind } from '../api/party-api.service';
import { NativePlayer } from '../../plugins/native-player.plugin';
import { AuthService } from '../auth.service';
import { DeviceService } from '../device.service';
import { SseService } from '../sse.service';
import { ToastService } from '../toast.service';
import { readFlag, writeFlag } from './local-flag';
import { PartyService } from './party.service';
import { SPEAK_HANG_MS, SPEAK_THRESHOLD, diffPeers, offersTo, peerKey, rms, routeSignal, type PeerId } from './voice-mesh';

const DUCK_KEY = 'party.voice.duck';
const GATHER_TIMEOUT_MS = 2000;
const RETRY_MS = 2000;
const MAX_RETRIES = 5;
const POLL_MS = 100;

interface Peer {
  id: PeerId;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  lastLoud: number;
  retries: number;
  /** Negotiation id the offerer stamps on its offer and the answerer echoes, so a stale answer is dropped. */
  sid: string;
}

/** Voice channel of the current party: a WebRTC audio mesh, signaled through the server. */
@Injectable({ providedIn: 'root' })
export class VoiceService {
  private readonly api = inject(PartyApiService);
  private readonly party = inject(PartyService);
  private readonly sse = inject(SseService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly device = inject(DeviceService);

  /** WebRTC is missing on some old TV webviews: no voice UI at all there. */
  readonly supported = typeof RTCPeerConnection !== 'undefined';
  readonly micAvailable = !this.device.isTv() && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  readonly joined = signal(false);
  readonly muted = signal(true);
  /** Why the mic is off while joined: no hardware/API, TV, or denied. */
  readonly micIssue = signal<'unavailable' | 'denied' | null>(null);
  readonly listenOnly = computed(() => !this.micAvailable || this.micIssue() !== null);
  readonly listenOnlyReason = computed(() =>
    this.device.isTv() ? 'tv' : (this.micIssue() ?? (this.micAvailable ? null : 'unavailable')),
  );
  readonly busy = signal(false);
  /** The browser refused to start a remote voice: the user has to tap to hear it. */
  readonly audioBlocked = signal(false);
  /** The browser gathers no ICE candidate at all (an extension or policy blocking WebRTC UDP): voice can't connect. */
  readonly blocked = signal(false);
  private probed = false;
  readonly speaking = signal<ReadonlySet<string>>(new Set());
  readonly duck = signal(readFlag(DUCK_KEY, true));
  /** Someone else is audible: the player lowers the movie. */
  readonly othersSpeaking = computed(() => {
    const me = this.me();
    return this.joined() && [...this.speaking()].some((k) => k !== (me && peerKey(me)));
  });

  private readonly peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localLoud = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  private partyId: number | null = null;

  /** This device as the server addresses it; null before the SSE stream or the session is up. */
  private me(): PeerId | null {
    const deviceId = this.sse.targetId();
    const userId = this.auth.user()?.id;
    return deviceId && userId != null ? { userId, deviceId } : null;
  }

  constructor() {
    this.sse.partyEvents.subscribe((e) => {
      if (e.type === 'party.signal' && e.partyId === this.party.party()?.id) void this.onSignal(e.from, e.kind, e.data);
    });
    effect(() => {
      const members = this.party.members();
      const partyId = this.party.party()?.id ?? null;
      untracked(() => {
        const switched = this.partyId !== null && partyId !== this.partyId;
        this.partyId = partyId;
        if (switched || partyId === null) this.teardown();
        if (partyId === null) return;
        void this.probe();
        if (this.joined()) this.sync(members);
      });
    });
    this.party.rejoined.subscribe(() => void this.onRejoin());
    if (typeof addEventListener === 'function') addEventListener('pagehide', () => this.onUnload());
  }

  setDuck(on: boolean): void {
    this.duck.set(on);
    writeFlag(DUCK_KEY, on);
  }

  /** The server forgot or marked away our voice flag (restart, long drop): say it again, then renegotiate with everyone. */
  private async onRejoin(): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    if (!this.joined() || id == null || !me) return;
    await this.api.voice(id, me, true, this.muted()).catch((err) => this.party.onActionError(err));
    this.resetPeers();
  }

  async join(): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.me();
    if (!this.supported || this.joined() || this.busy() || id == null || !me) return;
    this.busy.set(true);
    try {
      this.iceServers = (await this.api.iceServers().catch(() => ({ iceServers: [] as RTCIceServer[] }))).iceServers;
      // The audio session must record before WebKit opens the mic, or capture starts on `.playback` and stalls the player.
      if (Capacitor.getPlatform() === 'ios') await NativePlayer.setVoiceActive({ active: true }).catch(() => {});
      await this.openMic();
      // Peers offer as soon as the server flags us: an offer that lands before this is set is dropped.
      this.joined.set(true);
      await this.api.voice(id, me.deviceId, true, true);
      this.muted.set(true);
      this.startPoll();
      this.sync(this.party.members());
      // A peer that saw us vanish without a bye (app killed) holds a dead connection: ask it to offer again.
      for (const to of diffPeers([], this.party.members(), me).add) {
        if (!offersTo(me, to)) void this.send(to, 'bye', { retry: true });
      }
    } catch (err) {
      for (const key of [...this.peers.keys()]) this.closePeer(key);
      this.joined.set(false);
      this.releaseMic();
      if (Capacitor.getPlatform() === 'ios') void NativePlayer.setVoiceActive({ active: false }).catch(() => {});
      this.party.onActionError(err);
    } finally {
      this.busy.set(false);
    }
  }

  async leave(): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    if (!this.joined()) return;
    for (const { id: to } of this.peers.values()) void this.send(to, 'bye', {});
    this.teardown();
    if (id != null && me) await this.api.voice(id, me, false, true).catch(() => {});
  }

  toggleMute(): Promise<void> {
    return this.setMuted(!this.muted());
  }

  async setMuted(muted: boolean): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    const track = this.mic?.getAudioTracks()[0];
    if (!this.joined() || !track || id == null || !me || muted === this.muted()) return;
    track.enabled = !muted;
    this.muted.set(muted);
    await this.api.voice(id, me, true, muted).catch((err) => this.party.onActionError(err));
  }

  // ── Mesh ──

  private sync(members: readonly PartyMember[]): void {
    const me = this.me();
    if (!me) return;
    const { add, remove } = diffPeers(this.peers.keys(), members, me);
    for (const key of remove) this.closePeer(key);
    for (const id of add) if (offersTo(me, id)) void this.connect(id);
  }

  private resetPeers(): void {
    for (const key of [...this.peers.keys()]) this.closePeer(key);
    this.sync(this.party.members());
  }

  private createPeer(to: PeerId): Peer {
    this.closePeer(peerKey(to));
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { id: to, pc, audio, analyser: null, lastLoud: 0, retries: 0, sid: Math.random().toString(36).slice(2) };
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.mic) pc.addTrack(track, this.mic);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      audio.srcObject = stream;
      this.play(audio);
      peer.analyser = this.analyse(stream);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') peer.retries = 0;
      else if (pc.iceConnectionState === 'failed') this.onIceFailed(to, pc);
    };
    this.peers.set(peerKey(to), peer);
    return peer;
  }

  /** Resume every remote voice from a tap, once the browser has blocked autoplay. */
  enableAudio(): void {
    this.audioBlocked.set(false);
    for (const { audio } of this.peers.values()) this.play(audio);
  }

  private play(audio: HTMLAudioElement): void {
    audio.play().catch((err) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.audioBlocked.set(true);
    });
  }

  private onIceFailed(to: PeerId, pc: RTCPeerConnection): void {
    const key = peerKey(to);
    const peer = this.peers.get(key);
    const me = this.me();
    if (!peer || peer.pc !== pc || !me || peer.retries >= MAX_RETRIES) return;
    const retries = peer.retries + 1;
    this.closePeer(key);
    this.peers.set(key, { ...peer, retries }); // placeholder keeps the count across the delay
    setTimeout(() => {
      if (this.peers.get(key)?.retries !== retries || this.peers.get(key)?.pc !== pc) return;
      this.peers.delete(key);
      if (!this.joined()) return;
      if (offersTo(me, to)) void this.connect(to, retries);
      else void this.send(to, 'bye', { retry: true });
    }, RETRY_MS);
  }

  private async connect(to: PeerId, retries = 0): Promise<void> {
    const peer = this.createPeer(to);
    peer.retries = retries;
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await this.gathered(peer.pc);
      await this.send(to, 'offer', { ...peer.pc.localDescription!.toJSON(), sid: peer.sid });
    } catch {
      this.closePeer(peerKey(to));
    }
  }

  private async onSignal(from: PeerId, kind: PartySignalKind, data: Record<string, unknown>): Promise<void> {
    if (!this.joined()) return;
    const key = peerKey(from);
    const me = this.me();
    const action = routeSignal(kind, this.peers.has(key), data['retry'] === true);
    const peer = this.peers.get(key);
    try {
      switch (action) {
        case 'accept-offer': {
          const next = this.createPeer(from);
          next.sid = String(data['sid'] ?? next.sid);
          await next.pc.setRemoteDescription(data as unknown as RTCSessionDescriptionInit);
          await next.pc.setLocalDescription(await next.pc.createAnswer());
          await this.gathered(next.pc);
          await this.send(from, 'answer', { ...next.pc.localDescription!.toJSON(), sid: next.sid });
          return;
        }
        case 'apply-answer':
          if (data['sid'] !== undefined && data['sid'] !== peer!.sid) return;
          await peer!.pc.setRemoteDescription(data as unknown as RTCSessionDescriptionInit);
          return;
        case 'add-ice':
          await peer!.pc.addIceCandidate(data as unknown as RTCIceCandidateInit);
          return;
        case 'retry':
          this.closePeer(key);
          if (me && offersTo(me, from)) void this.connect(from);
          return;
        case 'close':
          this.closePeer(key);
          return;
      }
    } catch {
      this.closePeer(key);
    }
  }

  private async probe(): Promise<void> {
    if (this.probed || !this.supported) return;
    this.probed = true;
    const pc = new RTCPeerConnection();
    let found = false;
    pc.onicecandidate = (e) => {
      if (e.candidate) found = true;
    };
    try {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      await pc.setLocalDescription(await pc.createOffer());
      await this.gathered(pc);
      this.blocked.set(!found);
    } catch {
      /* no verdict: a real join still reports its own failure */
    } finally {
      pc.close();
    }
  }

  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => pc.iceGatheringState === 'complete' && done();
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private async send(to: PeerId, kind: PartySignalKind, data: object): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    if (id == null || !me) return;
    await this.api.signal(id, me, to.deviceId, to.userId, kind, data).catch((err) => {
      // Voice flags lag a beat behind members; anything else is worth saying.
      if (kind !== 'bye') this.party.onActionError(err);
    });
  }

  private closePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.close();
    peer.audio.srcObject = null;
    this.setSpeaking(id, false);
  }

  // ── Mic and levels ──

  private async openMic(): Promise<void> {
    this.micIssue.set(null);
    if (!this.micAvailable) {
      this.micIssue.set('unavailable');
      return;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.mic.getAudioTracks().forEach((t) => (t.enabled = false));
      this.localAnalyser = this.analyse(this.mic);
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      this.micIssue.set(denied ? 'denied' : 'unavailable');
      if (denied) this.toast.error(this.translate.instant('party.voice_mic_denied'));
    }
  }

  private releaseMic(): void {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.localAnalyser = null;
  }

  private analyse(stream: MediaStream): AnalyserNode | null {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    this.ctx ??= new Ctx();
    const node = this.ctx.createAnalyser();
    node.fftSize = 512;
    this.ctx.createMediaStreamSource(stream).connect(node);
    return node;
  }

  private startPoll(): void {
    this.poll ??= setInterval(() => this.measure(), POLL_MS);
  }

  private measure(): void {
    const now = Date.now();
    const me = this.me();
    const buf = new Uint8Array(512);
    const loud = (a: AnalyserNode | null): boolean => {
      if (!a) return false;
      a.getByteTimeDomainData(buf);
      return rms(buf) > SPEAK_THRESHOLD;
    };
    if (me) {
      if (loud(this.localAnalyser)) this.localLoud = now;
      this.setSpeaking(peerKey(me), now - this.localLoud < SPEAK_HANG_MS && !this.muted());
    }
    for (const [id, p] of this.peers) {
      if (loud(p.analyser)) p.lastLoud = now;
      this.setSpeaking(id, now - p.lastLoud < SPEAK_HANG_MS);
    }
  }

  private setSpeaking(id: string, on: boolean): void {
    if (this.speaking().has(id) === on) return;
    const next = new Set(this.speaking());
    if (on) next.add(id);
    else next.delete(id);
    this.speaking.set(next);
  }

  // ── Teardown ──

  private teardown(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.releaseMic();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.speaking.set(new Set());
    this.audioBlocked.set(false);
    if (this.joined() && Capacitor.getPlatform() === 'ios') void NativePlayer.setVoiceActive({ active: false }).catch(() => {});
    this.joined.set(false);
    this.muted.set(true);
    this.micIssue.set(null);
  }

  private onUnload(): void {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    if (!this.joined() || id == null || !me) return;
    this.api.leaveVoiceOnUnload(id, me);
    this.teardown();
  }
}
