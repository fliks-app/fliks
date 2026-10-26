import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { TranslateService } from '@ngx-translate/core';
import { PartyApiService, type PartyMember, type PartySignalKind } from '../api/party-api.service';
import { NativePlayer } from '../../plugins/native-player.plugin';
import { DeviceService } from '../device.service';
import { SseService } from '../sse.service';
import { ToastService } from '../toast.service';
import { readFlag, writeFlag } from './local-flag';
import { PartyService } from './party.service';
import { SPEAK_HANG_MS, SPEAK_THRESHOLD, diffPeers, offersTo, rms, routeSignal } from './voice-mesh';

const DUCK_KEY = 'party.voice.duck';
const GATHER_TIMEOUT_MS = 2000;
const RETRY_MS = 2000;
const MAX_RETRIES = 5;
const POLL_MS = 100;

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  lastLoud: number;
  retries: number;
}

/** Voice channel of the current party: a WebRTC audio mesh, signaled through the server. */
@Injectable({ providedIn: 'root' })
export class VoiceService {
  private readonly api = inject(PartyApiService);
  private readonly party = inject(PartyService);
  private readonly sse = inject(SseService);
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
    this.device.isTv() ? 'tv' : this.micIssue() === 'denied' ? 'denied' : !this.micAvailable ? 'unavailable' : null,
  );
  readonly busy = signal(false);
  readonly speaking = signal<ReadonlySet<string>>(new Set());
  readonly duck = signal(readFlag(DUCK_KEY, true));
  /** Someone else is audible: the player lowers the movie. */
  readonly othersSpeaking = computed(() => {
    const me = this.sse.targetId();
    return this.joined() && [...this.speaking()].some((id) => id !== me);
  });

  private readonly peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localLoud = 0;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sse.partyEvents.subscribe((e) => {
      if (e.type === 'party.signal' && e.partyId === this.party.party()?.id) void this.onSignal(e.from.deviceId, e.kind, e.data);
    });
    effect(() => {
      const members = this.party.members();
      const inParty = this.party.party() !== null;
      untracked(() => {
        if (!inParty) this.teardown();
        else if (this.joined()) this.sync(members);
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
    const me = this.sse.targetId();
    if (!this.supported || this.joined() || this.busy() || id == null || !me) return;
    this.busy.set(true);
    try {
      this.iceServers = (await this.api.iceServers().catch(() => ({ iceServers: [] as RTCIceServer[] }))).iceServers;
      // The audio session must record before WebKit opens the mic, or capture starts on `.playback` and stalls the player.
      if (Capacitor.getPlatform() === 'ios') await NativePlayer.setVoiceActive({ active: true }).catch(() => {});
      await this.openMic();
      await this.api.voice(id, me, true, true);
      this.muted.set(true);
      this.joined.set(true);
      this.startPoll();
      this.sync(this.party.members());
    } catch (err) {
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
    for (const to of this.peers.keys()) void this.send(to, 'bye', {});
    this.teardown();
    if (id != null && me) await this.api.voice(id, me, false, true).catch(() => {});
  }

  async toggleMute(): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    const track = this.mic?.getAudioTracks()[0];
    if (!this.joined() || !track || id == null || !me) return;
    const muted = !this.muted();
    track.enabled = !muted;
    this.muted.set(muted);
    await this.api.voice(id, me, true, muted).catch((err) => this.party.onActionError(err));
  }

  // ── Mesh ──

  private sync(members: readonly PartyMember[]): void {
    const me = this.sse.targetId();
    if (!me) return;
    const { add, remove } = diffPeers(this.peers.keys(), members, me);
    for (const id of remove) this.closePeer(id);
    for (const id of add) if (offersTo(me, id)) void this.connect(id);
  }

  private resetPeers(): void {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.sync(this.party.members());
  }

  private createPeer(to: string): Peer {
    this.closePeer(to);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { pc, audio, analyser: null, lastLoud: 0, retries: 0 };
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.mic) pc.addTrack(track, this.mic);
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      audio.srcObject = stream;
      void audio.play().catch(() => {});
      peer.analyser = this.analyse(stream);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') peer.retries = 0;
      else if (pc.iceConnectionState === 'failed') this.onIceFailed(to, pc);
    };
    this.peers.set(to, peer);
    return peer;
  }

  private onIceFailed(to: string, pc: RTCPeerConnection): void {
    const peer = this.peers.get(to);
    const me = this.sse.targetId();
    if (!peer || peer.pc !== pc || !me || peer.retries >= MAX_RETRIES) return;
    const retries = peer.retries + 1;
    this.closePeer(to);
    this.peers.set(to, { ...peer, retries }); // placeholder keeps the count across the delay
    setTimeout(() => {
      if (this.peers.get(to)?.retries !== retries || this.peers.get(to)?.pc !== pc) return;
      this.peers.delete(to);
      if (!this.joined()) return;
      if (offersTo(me, to)) void this.connect(to, retries);
      else void this.send(to, 'bye', { retry: true });
    }, RETRY_MS);
  }

  private async connect(to: string, retries = 0): Promise<void> {
    const peer = this.createPeer(to);
    peer.retries = retries;
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await this.gathered(peer.pc);
      await this.send(to, 'offer', peer.pc.localDescription!.toJSON());
    } catch {
      this.closePeer(to);
    }
  }

  private async onSignal(from: string, kind: PartySignalKind, data: Record<string, unknown>): Promise<void> {
    if (!this.joined()) return;
    const action = routeSignal(kind, this.peers.has(from), data['retry'] === true);
    const peer = this.peers.get(from);
    try {
      switch (action) {
        case 'accept-offer': {
          const next = this.createPeer(from);
          await next.pc.setRemoteDescription(data as unknown as RTCSessionDescriptionInit);
          await next.pc.setLocalDescription(await next.pc.createAnswer());
          await this.gathered(next.pc);
          await this.send(from, 'answer', next.pc.localDescription!.toJSON());
          return;
        }
        case 'apply-answer':
          await peer!.pc.setRemoteDescription(data as unknown as RTCSessionDescriptionInit);
          return;
        case 'add-ice':
          await peer!.pc.addIceCandidate(data as unknown as RTCIceCandidateInit);
          return;
        case 'retry':
          this.closePeer(from);
          if (this.sse.targetId() && offersTo(this.sse.targetId()!, from)) void this.connect(from);
          return;
        case 'close':
          this.closePeer(from);
          return;
      }
    } catch {
      this.closePeer(from);
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

  private async send(to: string, kind: PartySignalKind, data: object): Promise<void> {
    const id = this.party.party()?.id;
    const me = this.sse.targetId();
    if (id == null || !me) return;
    await this.api.signal(id, me, to, kind, data).catch((err) => {
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
    const me = this.sse.targetId();
    const buf = new Uint8Array(512);
    const loud = (a: AnalyserNode | null): boolean => {
      if (!a) return false;
      a.getByteTimeDomainData(buf);
      return rms(buf) > SPEAK_THRESHOLD;
    };
    if (me) {
      if (loud(this.localAnalyser)) this.localLoud = now;
      this.setSpeaking(me, now - this.localLoud < SPEAK_HANG_MS && !this.muted());
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
