import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export type SseEvent =
  | { type: 'task.progress'; command: string; current: number; total: number; message: string }
  | { type: 'subtitle.synced'; subtitleId: number; language: string; mediaId?: number }
  | { type: 'subtitle.downloaded'; mediaId: number; title: string; language: string; provider: string }
  | { type: 'subtitle.failed'; mediaId: number; title: string; language: string; error: string }
  | { type: 'import.complete'; mediaId: number; title: string }
  | { type: 'import.failed'; mediaId: number; title: string; error: string }
  | { type: 'stalled.removed'; title: string }
  | { type: 'queue.updated' };

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
}
