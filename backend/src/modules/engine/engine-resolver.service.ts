import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Equals, IsInt, IsNotEmpty, IsString, Min } from 'class-validator';
import { Repository } from 'typeorm';
import { LiveTvChannelsService } from '../livetv/services/livetv-channels.service';
import { LiveTvSessionService } from '../livetv/services/livetv-session.service';
import { User } from '../users/entities/user.entity';

/** What fliks-server's resolver forwards for `purpose: live` (bridge B1, `server/docs/bridge.md`):
 *  it has already authenticated the credential, so it names the user. */
export class LiveResolveDto {
  /** The live viewer's session id. */
  @IsString()
  @IsNotEmpty()
  mediaId!: string;

  @IsInt()
  @Min(1)
  userId!: number;

  @Equals('live')
  purpose!: 'live';
}

export interface LiveResolveResult {
  allow: boolean;
  ownerId?: string;
  ttlS: number;
}

const DENY: LiveResolveResult = { allow: false, ttlS: 60 };

@Injectable()
export class EngineResolverService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly liveSessions: LiveTvSessionService,
    private readonly channels: LiveTvChannelsService,
  ) {}

  /** The viewer must exist and its user may still play the channel; re-checked on every request (ttl 0). */
  async resolveLive(dto: LiveResolveDto): Promise<LiveResolveResult> {
    const user = await this.userRepo.findOne({
      where: { id: dto.userId, enabled: true },
      relations: ['userRole'],
    });
    const viewer = user && this.liveSessions.viewer(dto.mediaId);
    if (!user || !viewer) return DENY;
    try {
      await this.channels.findPlayable(viewer.channelId, user);
    } catch (err) {
      if (err instanceof HttpException) return DENY;
      throw err;
    }
    return { allow: true, ownerId: String(user.id), ttlS: 0 };
  }
}
