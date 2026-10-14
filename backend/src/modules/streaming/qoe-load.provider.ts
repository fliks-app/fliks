import { Injectable, OnModuleInit } from '@nestjs/common';
import { QoeService } from '../qoe/qoe.service';
import { EngineEventsService } from './services/engine-events.service';
import { LiveSessionRegistry } from './live-session.service';

/** Tells QoE how busy the server is when a stall is recorded; read on demand, never polled. */
@Injectable()
export class QoeLoadProvider implements OnModuleInit {
  constructor(
    private readonly qoe: QoeService,
    private readonly sessions: LiveSessionRegistry,
    private readonly engineEvents: EngineEventsService,
  ) {}

  onModuleInit(): void {
    this.qoe.setLoadProbe(() => ({
      activeTranscodes: this.engineEvents.activeJobs,
      activeSessions: this.sessions.list().length,
    }));
  }
}
