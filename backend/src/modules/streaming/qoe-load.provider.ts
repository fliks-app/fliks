import { Injectable, OnModuleInit } from '@nestjs/common';
import { QoeService } from '../qoe/qoe.service';
import { LiveSessionRegistry } from './live-session.service';
import { TranscodingService } from './transcoding/transcoding.service';

/** Tells QoE how busy the server is when a stall is recorded; read on demand, never polled. */
@Injectable()
export class QoeLoadProvider implements OnModuleInit {
  constructor(
    private readonly qoe: QoeService,
    private readonly transcoding: TranscodingService,
    private readonly sessions: LiveSessionRegistry,
  ) {}

  onModuleInit(): void {
    this.qoe.setLoadProbe(() => ({
      activeTranscodes: this.transcoding
        .getActiveSessions()
        .filter((s) => !s.remux && !s.throttlePaused && this.transcoding.isProducing(s)).length,
      activeSessions: this.sessions.list().length,
    }));
  }
}
