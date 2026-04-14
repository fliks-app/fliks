import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { LibrariesService } from './libraries.service';
import { CreateLibraryDto } from './dto/create-library.dto';
import { UpdateLibraryDto } from './dto/update-library.dto';
import { AddLibraryPathDto } from './dto/add-library-path.dto';
import { AssignLibraryAccessDto } from './dto/assign-library-access.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { User } from '../users/entities/user.entity';
import { Library } from './entities/library.entity';

@Controller('libraries')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class LibrariesController {
  constructor(private readonly service: LibrariesService) {}

  /** Lightweight library list for all authenticated users (sidebar). */
  @Get('mine')
  @CheckPolicies((ability) => ability.can(Action.Read, Library))
  findMine(@Req() req: Request) {
    return this.service.findAccessibleSummaries(req.user as User);
  }

  /** List the libraries the caller can read (admin — includes root folders + disk info). */
  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll(@Req() req: Request) {
    return this.service.findAllForUser(req.user as User);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateLibraryDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLibraryDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Post(':id/paths')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  addPath(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddLibraryPathDto,
  ) {
    return this.service.addPath(id, dto);
  }

  @Delete(':id/paths/:pathId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  removePath(
    @Param('id', ParseIntPipe) id: number,
    @Param('pathId', ParseIntPipe) pathId: number,
  ) {
    return this.service.removePath(id, pathId);
  }

  @Get(':id/access')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  getAccess(@Param('id', ParseIntPipe) id: number) {
    return this.service.getUserAccess(id);
  }

  @Put(':id/access')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  setAccess(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignLibraryAccessDto,
  ) {
    return this.service.setUserAccess(id, dto.userIds);
  }
}
