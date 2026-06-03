import { Controller, Get, UseGuards } from '@nestjs/common';
import { CountsService } from './counts.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

/**
 * Badge counts for the app shell. Auth-only on purpose: each count applies
 * its own ability check inside the service (a user without download-clients
 * read simply gets 0), so one endpoint serves every role.
 */
@Controller('counts')
@UseGuards(JwtOrApiKeyGuard)
export class CountsController {
  constructor(private readonly counts: CountsService) {}

  @Get()
  get(@CurrentUser() user: User) {
    return this.counts.getCounts(user);
  }
}
