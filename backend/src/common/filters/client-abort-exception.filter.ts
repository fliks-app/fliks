import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Drops errors that only surface because a client aborted a request in flight.
 *
 * When a browser/native client cancels an in-flight request — e.g. a superseded
 * `playback-info` fetch when the user switches quality, which Angular's
 * HttpClient aborts on unsubscribe — the TCP socket is destroyed. Node's
 * internal `socketOnError` can then throw `this.removeListener is not a
 * function` while the response is still being serialized, and any attempt to
 * write an error body fails again against the dead socket. There is nothing to
 * send to a client that is already gone and nothing actionable to report, so
 * swallow it instead of logging a spurious 500. Errors on a live connection
 * fall through to the default handler unchanged.
 */
@Catch()
export class ClientAbortExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(ClientAbortExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http' && this.isClientAbort(exception, host)) {
      this.logger.debug(
        `Dropped error after client disconnect: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      return;
    }
    super.catch(exception, host);
  }

  private isClientAbort(exception: unknown, host: ArgumentsHost): boolean {
    const req = host.switchToHttp().getRequest<Request>();
    const socket = req?.socket;
    if (
      req?.aborted === true ||
      (req as { readableAborted?: boolean })?.readableAborted === true ||
      socket?.destroyed === true
    ) {
      return true;
    }
    // Node's internal HTTP socket error handler throws "this.removeListener is
    // not a function" when a socket errors after being detached (client RST /
    // cancelled request). It surfaces through whatever async work was in flight
    // (often the response serialization), so socket state may already read as
    // alive by the time we get here — match the signature instead.
    if (exception instanceof Error) {
      const stack = exception.stack ?? '';
      if (
        /removeListener is not a function/i.test(exception.message) &&
        /socketOnError|_http_server/i.test(stack)
      ) {
        return true;
      }
    }
    return false;
  }
}
