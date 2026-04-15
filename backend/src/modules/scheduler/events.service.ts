import { Injectable } from '@nestjs/common';
import { Subject, Observable, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';

export type SseEvent =
  | {
      type: 'task.progress';
      command: string;
      current: number;
      total: number;
      message: string;
    }
  | {
      type: 'subtitle.synced';
      subtitleId: number;
      language: string;
      mediaId?: number;
    }
  | {
      type: 'subtitle.downloaded';
      mediaId: number;
      title: string;
      language: string;
      provider: string;
    }
  | {
      type: 'subtitle.failed';
      mediaId: number;
      title: string;
      language: string;
      error: string;
    }
  | { type: 'import.complete'; mediaId: number; title: string }
  | { type: 'import.failed'; mediaId: number; title: string; error: string }
  | { type: 'stalled.removed'; title: string }
  | { type: 'queue.updated' }
  | { type: 'command.started'; name: string }
  | { type: 'command.completed'; name: string; status: string }
  | { type: 'rescan.started'; mediaId: number; title: string }
  | {
      type: 'rescan.completed';
      mediaId: number;
      title: string;
      added: number;
      removed: number;
      updated: number;
      subtitleRemovedMissing?: number;
      subtitleRemovedDuplicates?: number;
    }
  | { type: 'rescan.failed'; mediaId: number; title: string; error: string }
  | {
      type: 'player.command';
      mediaFileId: number;
      userId: number;
      action: 'pause' | 'play' | 'stop' | 'message';
      message?: string;
    }
  | { type: 'download.progress'; downloadId: number; progress: number }
  | { type: 'download.ready'; downloadId: number }
  | { type: 'download.failed'; downloadId: number; error: string }
  | {
      type: 'markers.season.completed';
      mediaId: number;
      seasonId: number;
      seasonNumber: number;
      introsDetected: number;
    }
  | { type: 'metadata.started'; mediaId: number; title: string }
  | { type: 'metadata.refreshed'; mediaId: number; title: string }
  | {
      type: 'metadata.failed';
      mediaId: number;
      title: string;
      error: string;
    }
  | {
      type: 'watch-history.import.started';
      serverId: number;
      serverName: string;
    }
  | {
      type: 'watch-history.import.completed';
      serverId: number;
      serverName: string;
      users: number;
      usersCreated: number;
      imported: number;
      skipped: number;
    }
  | {
      type: 'watch-history.import.failed';
      serverId: number;
      serverName: string;
      error: string;
    }
  | { type: 'seerr.import.started' }
  | {
      type: 'seerr.import.completed';
      users: number;
      usersCreated: number;
      imported: number;
      updated: number;
      skipped: number;
    }
  | { type: 'seerr.import.failed'; error: string };

@Injectable()
export class EventsService {
  private readonly subject = new Subject<SseEvent>();

  emit(event: SseEvent): void {
    this.subject.next(event);
  }

  getStream(): Observable<MessageEvent> {
    return this.subject
      .asObservable()
      .pipe(map((data) => ({ data: JSON.stringify(data) }) as MessageEvent));
  }

  /** Backend-internal listener — used by services that react to other modules' events. */
  subscribe(handler: (event: SseEvent) => void): Subscription {
    return this.subject.subscribe(handler);
  }
}
