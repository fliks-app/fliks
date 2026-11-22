import { Injectable, inject, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { RemoteService } from '../../core/services/remote.service';
import { SseService, type RemoteCommand, type SseEvent } from '../../core/services/sse.service';
import { ControlsVisibilityService } from './controls/controls-visibility';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { QueueController } from './queue-controller';

export interface RemoteHost {
  mediaFileId(): number;
  activeSessionId(): string | undefined;
  duration(): number;
  onTogglePlay(): void;
  onSeek(time: number): void;
  savePosition(force: boolean): Promise<void>;
}

/** Commands from other devices and from admins: the SSE `player.command` events targeting this
 *  session, and the validated user commands of RemoteService. */
@Injectable()
export class RemoteController {
  private readonly sseService = inject(SseService);
  private readonly authService = inject(AuthService);
  private readonly remoteService = inject(RemoteService);
  private readonly chrome = inject(ControlsVisibilityService);
  private readonly queueCtl = inject(QueueController);
  private readonly session = inject(PlaybackSession);
  private host!: RemoteHost;
  private sub: Subscription | null = null;
  private adminSub: Subscription | null = null;

  /** Admin message overlay, rendered inside the player container so it stays visible in
   *  browser fullscreen (the global toast layer sits outside the fullscreened element). */
  readonly adminMessage = signal<string | null>(null);
  private adminMessageTimer: ReturnType<typeof setTimeout> | null = null;

  /** User-facing commands arrive already validated (expiry, unknown action) by RemoteService,
   *  and delivery is per-connection: no mediaFileId/sessionId filter needed. */
  attach(host: RemoteHost): void {
    this.host = host;
    this.sub = this.remoteService.validated.subscribe((cmd) => void this.applyRemoteCommand(cmd));
    this.adminSub = this.sseService.on('player.command').subscribe((event) => this.onAdminCommand(event));
  }

  dispose(): void {
    this.sub?.unsubscribe();
    this.adminSub?.unsubscribe();
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
  }

  dismissAdminMessage() {
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
    this.adminMessageTimer = null;
    this.adminMessage.set(null);
  }

  /** Handles an admin `player.command` SSE event. */
  private onAdminCommand(event: SseEvent): void {
    const cmd = event as any;
    const currentUserId = this.authService.user()?.id;
    if (cmd.mediaFileId !== this.host.mediaFileId() || cmd.userId !== currentUserId) return;

    // The same user can watch the same file on several devices at once —
    // only the targeted live session should react.
    if (cmd.sessionId) {
      const sid = this.host.activeSessionId();
      if (!sid || cmd.sessionId !== sid) return;
    }

    if (cmd.action === 'message') {
      const text = (cmd.message as string)?.trim();
      if (text) this.showAdminMessage(text);
      return;
    }

    const output = this.session.output();
    if (cmd.action === 'pause') void output?.pause();
    else if (cmd.action === 'play') output?.play();
    else if (cmd.action === 'stop') this.session.stop();
  }

  async applyRemoteCommand(cmd: RemoteCommand): Promise<void> {
    const output = this.session.output();
    let refused: string | undefined;
    switch (cmd.action) {
      case 'play':
        output?.play();
        break;
      case 'pause':
        void output?.pause();
        // A remote pause is a remote viewer stepping in, so surface the controls
        // the way a local pause does rather than freezing on a bare frame.
        this.chrome.show();
        break;
      case 'playpause':
        if (!this.session.command({ type: 'toggle' })) this.host.onTogglePlay();
        this.chrome.show();
        break;
      case 'seek':
        if (cmd.positionSeconds === undefined) {
          console.warn('[remote] seek command missing positionSeconds', cmd.cmdId);
          refused = 'missing_position';
          break;
        }
        if (this.session.command({ type: 'seek', at: cmd.positionSeconds })) break;
        if (!this.host.duration()) {
          console.warn('[remote] dropping seek received before duration is known', cmd.cmdId);
          refused = 'duration_unknown';
          break;
        }
        this.host.onSeek(cmd.positionSeconds);
        break;
      case 'volume':
        if (cmd.level === undefined) {
          console.warn('[remote] volume command missing level', cmd.cmdId);
          refused = 'missing_level';
          break;
        }
        output?.setVolume(cmd.level);
        break;
      case 'mute':
        if (cmd.muted === undefined) {
          console.warn('[remote] mute command missing muted flag', cmd.cmdId);
          refused = 'missing_muted';
          break;
        }
        if (output && output.muted() !== cmd.muted) output.toggleMute();
        break;
      case 'next':
        if (!this.queueCtl.upNext()) {
          console.warn('[remote] next: no item to advance to', cmd.cmdId);
          refused = 'no_next';
          break;
        }
        void this.queueCtl.advance();
        break;
      case 'audio':
        if (!cmd.trackId) {
          console.warn('[remote] audio command missing trackId', cmd.cmdId);
          refused = 'missing_track';
          break;
        }
        await output?.selectAudioById(cmd.trackId);
        break;
      case 'subtitle':
        await output?.selectSubtitleById(cmd.subtitleId ?? null);
        break;
      case 'quality':
        if (!cmd.qualityId) {
          console.warn('[remote] quality without a qualityId', cmd.cmdId);
          refused = 'missing_quality';
          break;
        }
        await output?.selectQualityById(cmd.qualityId);
        break;
      case 'stop':
        this.remoteService.markApplied(cmd.cmdId);
        void this.host.savePosition(true);
        this.session.stop();
        return;
      case 'load':
        // RemoteService owns 'load' end-to-end; never republished to this Subject.
        return;
    }
    this.remoteService.markApplied(cmd.cmdId, refused);
    await this.host.savePosition(true);
  }

  private showAdminMessage(text: string) {
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
    this.adminMessage.set(text);
    this.adminMessageTimer = setTimeout(() => this.adminMessage.set(null), 6000);
  }
}
