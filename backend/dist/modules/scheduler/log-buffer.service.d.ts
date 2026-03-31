import { ConsoleLogger, LoggerService } from '@nestjs/common';
export interface LogEntry {
    timestamp: string;
    level: 'log' | 'warn' | 'error' | 'debug';
    context: string;
    message: string;
}
export declare class LogBufferService extends ConsoleLogger implements LoggerService {
    private buffer;
    private readonly maxSize;
    log(message: any, context?: string): void;
    warn(message: any, context?: string): void;
    error(message: any, trace?: string, context?: string): void;
    debug(message: any, context?: string): void;
    private push;
    getEntries(opts?: {
        level?: string;
        q?: string;
        limit?: number;
    }): LogEntry[];
}
