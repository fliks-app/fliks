import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import {
  OWN_MODULE_ORIGIN,
  SettingsService,
} from '../settings/settings.service';
import { EngineService } from './engine.service';
import {
  ENGINE_PATH_MAPPINGS_KEY,
  ENGINE_TOKEN_KEY,
  ENGINE_URL_KEY,
  parsePathMappings,
  sanitizePathMappings,
} from './engine-remote-config';

class PathMappingDto {
  @IsString()
  from!: string;

  @IsString()
  to!: string;
}

class PutEngineRemoteDto {
  @IsString()
  url!: string;

  @IsString()
  token!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PathMappingDto)
  pathMappings!: PathMappingDto[];
}

class TestEngineRemoteDto {
  @IsString()
  url!: string;

  @IsString()
  token!: string;

  @IsOptional()
  @IsString()
  probePath?: string;
}

@Controller('engine/remote')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class EngineRemoteController {
  constructor(
    private readonly engine: EngineService,
    private readonly settings: SettingsService,
  ) {}

  private async snapshot() {
    const [url, token, raw] = await Promise.all([
      this.settings.get(ENGINE_URL_KEY),
      this.settings.get(ENGINE_TOKEN_KEY),
      this.settings.get(ENGINE_PATH_MAPPINGS_KEY),
    ]);
    const pathMappings = parsePathMappings(raw);
    const status = this.engine.status;
    return {
      url: url ?? '',
      token: token ?? '',
      pathMappings,
      status,
      ...(status === 'down' && {
        error: 'The streaming engine is unreachable',
      }),
    };
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  getRemote() {
    return this.snapshot();
  }

  @Put()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async putRemote(@Body() dto: PutEngineRemoteDto) {
    const pathMappings = sanitizePathMappings(dto.pathMappings);
    await this.settings.set(ENGINE_URL_KEY, dto.url, OWN_MODULE_ORIGIN);
    await this.settings.set(ENGINE_TOKEN_KEY, dto.token, OWN_MODULE_ORIGIN);
    await this.settings.set(
      ENGINE_PATH_MAPPINGS_KEY,
      pathMappings.length ? JSON.stringify(pathMappings) : null,
      OWN_MODULE_ORIGIN,
    );
    await this.engine.reconfigure();
    return this.snapshot();
  }

  @Post('test')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  testRemote(@Body() dto: TestEngineRemoteDto) {
    return this.engine.testConnection(dto.url, dto.token, dto.probePath);
  }
}
