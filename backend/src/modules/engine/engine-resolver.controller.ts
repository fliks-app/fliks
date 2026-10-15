import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { EngineService } from './engine.service';
import {
  EngineResolverService,
  ResolveRequestDto,
  type ResolveResult,
} from './engine-resolver.service';

@Injectable()
export class EngineHostGuard implements CanActivate {
  constructor(private readonly engine: EngineService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!this.engine.isHostAuth(req.headers.authorization)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

/** Outside the `/api` prefix (see main.ts): the engine calls `{hostUrl}/engine/resolve`. */
@Controller('engine')
@UseGuards(EngineHostGuard)
export class EngineResolverController {
  constructor(private readonly resolver: EngineResolverService) {}

  @Post('resolve')
  @HttpCode(200)
  resolve(@Body() dto: ResolveRequestDto): Promise<ResolveResult> {
    return this.resolver.resolve(dto);
  }
}
