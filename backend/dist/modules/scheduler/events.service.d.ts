import { Observable } from 'rxjs';
export interface TaskProgress {
    command: string;
    current: number;
    total: number;
    message: string;
}
export declare class EventsService {
    private readonly subject;
    emit(progress: TaskProgress): void;
    getStream(): Observable<MessageEvent>;
}
