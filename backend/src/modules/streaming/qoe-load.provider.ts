import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { EngineService } from '../engine/engine.service';
import { QoeService } from '../qoe/qoe.service';
import { EngineEventsService } from './services/engine-events.service';
import { LiveSessionRegistry } from './live-session.service';
import { TranscodingService } from './transcoding/transcoding.service';

/** Tells QoE how busy the server is when a stall is recorded; read on demand, never polled. */
@Injectable()
export class QoeLoadProvider implements OnModuleInit {
  constructor(
    private readonly qoe: QoeService,
    private readonly transcoding: TranscodingService,
    private readonly sessions: LiveSessionRegistry,
    @Optional() private readonly engine?: EngineService,
    @Optional() private readonly engineEvents?: EngineEventsService,
  ) {}

  onModuleInit(): void {
    this.qoe.setLoadProbe(() => ({
      activeTranscodes:
        this.engine?.runtime && this.engineEvents
          ? this.engineEvents.activeJobs
          : this.transcoding
              .getActiveSessions()
              .filter(
                (s) =>
                  !s.remux &&
                  !s.throttlePaused &&
                  this.transcoding.isProducing(s),
              ).length,
      activeSessions: this.sessions.list().length,
    }));
  }
}
