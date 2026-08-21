import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RelinkOrphansDto } from './relink-orphans.dto';

/** Every group the creation wizard detected, imported in one background run. */
export class RelinkOrphansBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RelinkOrphansDto)
  items: RelinkOrphansDto[];
}
