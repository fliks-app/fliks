import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { User } from '../users/entities/user.entity';

@Controller('roles')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  findAll() {
    return this.rolesService.findAll();
  }

  @Get('permissions')
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  getPermissions() {
    return this.rolesService.getAvailablePermissions();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.findOne(id);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  create(@Body() dto: CreateRoleDto) {
    return this.rolesService.create(dto);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRoleDto) {
    return this.rolesService.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, User))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.rolesService.remove(id);
  }
}
