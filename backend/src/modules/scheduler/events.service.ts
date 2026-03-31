import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface TaskProgress {
  command: string;
  current: number;
  total: number;
  message: string;
}

@Injectable()
export class EventsService {
  private readonly subject = new Subject<TaskProgress>();

  emit(progress: TaskProgress): void {
    this.subject.next(progress);
  }

  getStream(): Observable<MessageEvent> {
    return this.subject.asObservable().pipe(
      map((data) => ({ data: JSON.stringify(data) } as MessageEvent)),
    );
  }
}
