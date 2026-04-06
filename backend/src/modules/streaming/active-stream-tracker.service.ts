import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

export interface DirectPlaySession {
  userId: number;
  username: string;
  mediaFileId: number;
  mediaTitle: string;
  mediaType: string;
  posterUrl: string | null;
  startedAt: Date;
  lastActivity: Date;
}

const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

@Injectable()
export class ActiveStreamTracker implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, DirectPlaySession>();
  /** Cache transcode reasons per mediaFileId (set during playback-info, read by dashboard) */
  private readonly transcodeReasonsCache = new Map<
    number,
    { flag: string; message: string }[]
  >();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  onModuleInit() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
  }

  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  register(
    userId: number,
    username: string,
    mediaFileId: number,
    mediaTitle: string,
    mediaType: string,
    posterUrl: string | null,
  ) {
    const key = `${userId}-${mediaFileId}`;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastActivity = new Date();
      return;
    }
    this.sessions.set(key, {
      userId,
      username,
      mediaFileId,
      mediaTitle,
      mediaType,
      posterUrl,
      startedAt: new Date(),
      lastActivity: new Date(),
    });
  }

  unregister(userId: number, mediaFileId: number) {
    this.sessions.delete(`${userId}-${mediaFileId}`);
  }

  private readonly tonemappingCache = new Map<number, boolean>();

  setTranscodeReasons(
    mediaFileId: number,
    reasons: { flag: string; message: string }[],
  ) {
    this.transcodeReasonsCache.set(mediaFileId, reasons);
  }

  getTranscodeReasons(
    mediaFileId: number,
  ): { flag: string; message: string }[] {
    return this.transcodeReasonsCache.get(mediaFileId) ?? [];
  }

  private readonly burnInCache = new Map<number, any>();

  setTonemapping(mediaFileId: number, value: boolean) {
    this.tonemappingCache.set(mediaFileId, value);
  }

  getTonemapping(mediaFileId: number): boolean {
    return this.tonemappingCache.get(mediaFileId) ?? false;
  }

  setBurnIn(mediaFileId: number, info: any) {
    if (info) {
      this.burnInCache.set(mediaFileId, info);
    } else {
      this.burnInCache.delete(mediaFileId);
    }
  }

  getBurnIn(mediaFileId: number): any {
    return this.burnInCache.get(mediaFileId) ?? undefined;
  }

  private readonly audioStreamIndexCache = new Map<
    number,
    number | undefined
  >();

  setAudioStreamIndex(mediaFileId: number, index: number | undefined) {
    if (index != null) this.audioStreamIndexCache.set(mediaFileId, index);
    else this.audioStreamIndexCache.delete(mediaFileId);
  }

  getAudioStreamIndex(mediaFileId: number): number | undefined {
    return this.audioStreamIndexCache.get(mediaFileId);
  }

  getActive(): DirectPlaySession[] {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    return Array.from(this.sessions.values()).filter(
      (s) => s.lastActivity.getTime() > cutoff,
    );
  }

  private cleanup() {
    const cutoff = Date.now() - STALE_TIMEOUT_MS;
    for (const [key, session] of this.sessions) {
      if (session.lastActivity.getTime() <= cutoff) {
        this.sessions.delete(key);
      }
    }
  }
}
