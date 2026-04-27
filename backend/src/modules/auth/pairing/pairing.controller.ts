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
  UseGuards,
} from '@nestjs/common';
import { PairingService } from './pairing.service';
import { PairingRequestDto } from './dto/pairing.dto';
import { JwtOrApiKeyGuard } from '../guards/jwt-or-api-key.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { User } from '../../users/entities/user.entity';

const DEVICE_ID_HEADER = 'X-Device-Id';

@Controller('auth/pairing')
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

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
  status(
    @Query('pairingId') pairingId: string,
    @Headers('x-device-id') deviceId: string,
  ) {
    if (!pairingId) throw new BadRequestException('Missing pairingId');
    if (!deviceId) throw new BadRequestException(`Missing ${DEVICE_ID_HEADER} header`);
    return this.pairing.status(pairingId, deviceId);
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
