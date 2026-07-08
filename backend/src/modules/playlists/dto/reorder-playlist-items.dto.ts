import { IsArray, IsInt } from 'class-validator';

export class ReorderPlaylistItemsDto {
  /** Playlist item ids in the desired order (each item's position becomes its
   *  index in this array). */
  @IsArray()
  @IsInt({ each: true })
  itemIds: number[];
}
