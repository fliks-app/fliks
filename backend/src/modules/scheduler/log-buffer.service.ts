import { Injectable, ConsoleLogger } from '@nestjs/common';

/** The log ring behind `/api/system/logs` lives in fliks-server; this stays a console logger until S8. */
@Injectable()
export class LogBufferService extends ConsoleLogger {}
