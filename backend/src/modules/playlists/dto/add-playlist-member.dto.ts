import { IsEnum, IsInt } from 'class-validator';
import { PlaylistShareRole } from '../../../common/enums';

/** Grant (or update) a member's role on a playlist. */
export class AddPlaylistMemberDto {
  @IsInt()
  userId: number;

  @IsEnum(PlaylistShareRole)
  role: PlaylistShareRole;
}
