import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';

export class MergeChannelsDto {
  @IsInt()
  targetChannelId: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  sourceChannelIds: number[];
}
