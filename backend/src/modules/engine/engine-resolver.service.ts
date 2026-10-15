import { HttpException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import * as path from 'path';
import { Repository } from 'typeorm';
import { ACCESS_TOKEN_COOKIE } from '../auth/auth.constants';
import { parseCookieValue } from '../auth/request-cookie.util';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { LiveTvChannelsService } from '../livetv/services/livetv-channels.service';
import { LiveTvSessionService } from '../livetv/services/livetv-session.service';
import { StreamingService } from '../streaming/streaming.service';
import { SubtitleStreamService } from '../streaming/subtitle-stream.service';
import { ThumbnailService } from '../streaming/thumbnail.service';
import { User } from '../users/entities/user.entity';

const PURPOSES = ['stream', 'download', 'sprite', 'subtitle', 'live'] as const;
const TTL_S = 60;

export class ResolveRequestDto {
  /** The media file id; the live session id for `live`. */
  @IsDefined()
  mediaId!: number | string;

  /** Raw cookie header, `Bearer <jwt>` or the bare `?token=` value. */
  @IsString()
  credential!: string;

  @IsIn(PURPOSES)
  purpose!: (typeof PURPOSES)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  subtitleId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  streamIndex?: number;
}

export interface ResolveResult {
  allow: boolean;
  path?: string;
  ownerId?: string;
  format?: string;
  ttlS: number;
}

const DENY: ResolveResult = { allow: false, ttlS: TTL_S };

function tokenOf(credential: string): string | null {
  const c = credential.trim();
  const bearer = /^Bearer\s+(\S+)$/i.exec(c);
  if (bearer) return bearer[1];
  return (
    (c.includes('=') ? parseCookieValue(c, ACCESS_TOKEN_COOKIE) : c) || null
  );
}

/** Same credential and ACL rules as the `/api/stream` routes, answered as data for the engine. */
@Injectable()
export class EngineResolverService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly jwt: JwtService,
    private readonly streaming: StreamingService,
    private readonly subtitles: SubtitleStreamService,
    private readonly thumbnails: ThumbnailService,
    private readonly liveSessions: LiveTvSessionService,
    private readonly channels: LiveTvChannelsService,
  ) {}

  async resolve(dto: ResolveRequestDto): Promise<ResolveResult> {
    const user = await this.userFor(dto.credential);
    if (!user) return DENY;
    try {
      const found = await this.locate(user, dto);
      return { allow: true, ownerId: String(user.id), ttlS: TTL_S, ...found };
    } catch (err) {
      // An HTTP error is the routes' own refusal (404 shape included); anything else is a host fault.
      if (err instanceof HttpException) return DENY;
      throw err;
    }
  }

  /** Mirrors JwtStrategy: valid signature and expiry, user still enabled. */
  private async userFor(credential: string): Promise<User | null> {
    const token = tokenOf(credential);
    if (!token) return null;
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      return null;
    }
    return this.userRepo.findOne({
      where: { id: payload.sub, enabled: true },
      relations: ['userRole'],
    });
  }

  private async locate(
    user: User,
    dto: ResolveRequestDto,
  ): Promise<Partial<Pick<ResolveResult, 'path' | 'format' | 'ttlS'>>> {
    if (dto.purpose === 'live') {
      const viewer = this.liveSessions.viewer(String(dto.mediaId));
      if (!viewer) throw new HttpException('not found', 404);
      await this.channels.findPlayable(viewer.channelId, user);
      // Re-checked on every request, as the playlist poll was.
      return { ttlS: 0 };
    }
    const id = Number(dto.mediaId);
    if (!Number.isInteger(id) || id <= 0)
      throw new HttpException('bad id', 400);

    if (dto.purpose === 'subtitle' && dto.subtitleId !== undefined) {
      const file = await this.subtitles.getSubtitleFileForDownload(
        dto.subtitleId,
        user,
      );
      return {
        path: file.path,
        format: path.extname(file.path).slice(1).toLowerCase(),
      };
    }
    const resolved = await this.streaming.resolveFile(id, user);
    switch (dto.purpose) {
      case 'sprite':
        return { path: this.thumbnails.getSpritePath(id) };
      case 'subtitle':
        // Embedded track: the engine extracts `streamIndex` from the media file itself.
        if (dto.streamIndex === undefined)
          throw new HttpException('bad request', 400);
        return { path: resolved.absolutePath, format: 'embedded' };
      default:
        return { path: resolved.absolutePath };
    }
  }
}
