import { Module } from '@nestjs/common';
import { FfprobeService } from './ffprobe.service';

@Module({
  providers: [FfprobeService],
  exports: [FfprobeService],
})
export class MediaProbeModule {}
