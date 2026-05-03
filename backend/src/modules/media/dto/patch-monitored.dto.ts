import { IsBoolean } from 'class-validator';

export class PatchMonitoredDto {
  @IsBoolean()
  monitored: boolean;
}
