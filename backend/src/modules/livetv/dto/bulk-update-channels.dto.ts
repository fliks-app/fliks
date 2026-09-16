import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Which channels the patch applies to. Several narrow together. */
export class BulkChannelSelectionDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  channelIds?: number[];

  @IsOptional()
  @IsString()
  group?: string;

  @IsOptional()
  @IsInt()
  sourceId?: number;

  /** Matched case-insensitively against the channel name. */
  @IsOptional()
  @IsString()
  namePattern?: string;
}

export class BulkUpdateChannelsDto {
  @IsNotEmptyObject()
  @ValidateNested()
  @Type(() => BulkChannelSelectionDto)
  selection: BulkChannelSelectionDto;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  groupName?: string;

  /** Renumbers the selection in its current order, starting from this value. */
  @IsOptional()
  @IsInt()
  startNumber?: number;
}
