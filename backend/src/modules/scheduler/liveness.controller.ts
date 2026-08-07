import { Controller, Get } from '@nestjs/common';

/** Unauthenticated by design — the only route a container HEALTHCHECK can
 *  call before any credentials exist. No `@UseGuards`, no dependencies. */
@Controller('system')
export class LivenessController {
  @Get('liveness')
  liveness(): { ok: true } {
    return { ok: true };
  }
}
