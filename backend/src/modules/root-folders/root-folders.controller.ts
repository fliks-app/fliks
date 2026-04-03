import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { RootFoldersService } from './root-folders.service';
import { CreateRootFolderDto } from './dto/create-root-folder.dto';
import { UpdateRootFolderDto } from './dto/update-root-folder.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';

// Root folders are a settings concern — admin-only via 'Settings' subject
@Controller('root-folders')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class RootFoldersController {
  constructor(private readonly service: RootFoldersService) {}

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  create(@Body() dto: CreateRootFolderDto) {
    return this.service.create(dto);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Settings'))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRootFolderDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
