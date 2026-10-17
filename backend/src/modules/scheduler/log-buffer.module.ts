import { Module } from '@nestjs/common';
import { LogBufferService } from './log-buffer.service';

@Module({
  providers: [LogBufferService],
  exports: [LogBufferService],
})
export class LogBufferModule {}
