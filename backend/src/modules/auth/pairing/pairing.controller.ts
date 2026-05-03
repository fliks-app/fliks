import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PairingService } from './pairing.service';
import { PairingRequestDto } from './dto/pairing.dto';
import { JwtOrApiKeyGuard } from '../guards/jwt-or-api-key.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { User } from '../../users/entities/user.entity';
import { AuthService } from '../auth.service';
import { ACCESS_TOKEN_COOKIE } from '../auth.constants';
import { cookieOpts } from '../cookie-opts.util';

const DEVICE_ID_HEADER = 'X-Device-Id';

@Controller('auth/pairing')
export class PairingController {
  constructor(
    private readonly pairing: PairingService,
    private readonly authService: AuthService,
  ) {}

  /** TV-side: open a request to log in as a chosen user. No auth. */
  @Post('request')
  request(
    @Body() dto: PairingRequestDto,
    @Headers('x-device-id') deviceId: string,
  ) {
    if (!deviceId) {
      throw new BadRequestException('Missing X-Device-Id header');
    }
    return this.pairing.request(dto.userId, deviceId, dto.deviceName);
  }

  /**
   * TV-side: poll until status flips. The token only ships back to the
   * `X-Device-Id` that opened the request, so leaking the pairingId in logs
   * doesn't leak the token.
   */
  @Get('status')
  async status(
    @Query('pairingId') pairingId: string,
    @Headers('x-device-id') deviceId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!pairingId) throw new BadRequestException('Missing pairingId');
    if (!deviceId) throw new BadRequestException(`Missing ${DEVICE_ID_HEADER} header`);
    const result = await this.pairing.status(pairingId, deviceId);
    // When the token ships back, set the auth cookie too — same flow as
    // POST /auth/login. Native clients use the JSON token via Bearer; web
    // clients need the cookie so the next /auth/me succeeds without help.
    if (result.accessToken) {
      const maxAgeMs = this.authService.getAccessCookieMaxAgeMs();
      res.cookie(ACCESS_TOKEN_COOKIE, result.accessToken, cookieOpts(req, maxAgeMs));
    }
    return result;
  }

  /** Phone-side: list pending requests targeting the calling user. */
  @Get('pending')
  @UseGuards(JwtOrApiKeyGuard)
  pending(@CurrentUser() user: User) {
    return this.pairing.listPendingForUser(user.id);
  }

  /** Phone-side: approve a request the calling user owns. */
  @Post(':pairingId/approve')
  @HttpCode(204)
  @UseGuards(JwtOrApiKeyGuard)
  approve(@Param('pairingId') pairingId: string, @CurrentUser() user: User) {
    return this.pairing.approve(pairingId, user);
  }

  /** Phone-side: deny a request the calling user owns. */
  @Post(':pairingId/deny')
  @HttpCode(204)
  @UseGuards(JwtOrApiKeyGuard)
  deny(@Param('pairingId') pairingId: string, @CurrentUser() user: User) {
    return this.pairing.deny(pairingId, user);
  }
}
