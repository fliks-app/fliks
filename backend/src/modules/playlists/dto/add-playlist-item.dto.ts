import { IsInt } from 'class-validator';

export class AddPlaylistItemDto {
  @IsInt()
  mediaId: number;
}
