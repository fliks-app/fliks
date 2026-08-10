import { IsBoolean } from 'class-validator';

export class SetPluginEnabledDto {
  @IsBoolean()
  enabled: boolean;
}
