import { HttpException } from '@nestjs/common';

/**
 * Every install-pipeline refusal that isn't an archive-guard code, with a
 * stable `{ code, message }` body (same shape as `SessionExpiredException`)
 * so a caller branches on `code`, never on the HTTP status alone.
 */
export class PluginInstallException extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    detail: string,
  ) {
    super({ code, message: detail }, status);
  }
}
