import { Injectable, ConsoleLogger, LoggerService } from '@nestjs/common';

export interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error' | 'debug';
  context: string;
  message: string;
}

@Injectable()
export class LogBufferService extends ConsoleLogger implements LoggerService {
  private buffer: LogEntry[] = [];
  private readonly maxSize = 2000;

  log(message: any, context?: string): void {
    super.log(message, context);
    this.push('log', String(message), context ?? '');
  }

  warn(message: any, context?: string): void {
    super.warn(message, context);
    this.push('warn', String(message), context ?? '');
  }

  error(message: any, trace?: string, context?: string): void {
    super.error(message, trace, context);
    this.push(
      'error',
      String(message) + (trace ? `\n${trace}` : ''),
      context ?? '',
    );
  }

  debug(message: any, context?: string): void {
    super.debug(message, context);
    this.push('debug', String(message), context ?? '');
  }

  private push(level: LogEntry['level'], message: string, context: string) {
    this.buffer.push({
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
    });
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }
  }

  getEntries(opts?: {
    level?: string;
    q?: string;
    limit?: number;
  }): LogEntry[] {
    let entries = [...this.buffer];
    if (opts?.level) entries = entries.filter((e) => e.level === opts.level);
    if (opts?.q) {
      const q = opts.q.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.message.toLowerCase().includes(q) ||
          e.context.toLowerCase().includes(q),
      );
    }
    entries.reverse(); // newest first
    if (opts?.limit && opts.limit > 0) entries = entries.slice(0, opts.limit);
    return entries;
  }
}
