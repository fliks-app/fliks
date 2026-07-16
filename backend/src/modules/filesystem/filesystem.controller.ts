import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { FilesystemService } from './filesystem.service';
import type { FsListing } from './filesystem.service';

@Controller('fs')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class FilesystemController {
  constructor(private readonly fsService: FilesystemService) {}

  /** Browse server directories for the admin folder picker (library paths,
   *  disk import). Same gate as library management. */
  @Get('browse')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  browse(@Query('path') path?: string): FsListing {
    return this.fsService.list(path);
  }
}
