import { ArgumentsHost, Catch, ExceptionFilter, PayloadTooLargeException } from '@nestjs/common';
import type { Response } from 'express';

/** Multer's English 413 body, swapped for the key the client translates. */
@Catch(PayloadTooLargeException)
export class FileTooLargeFilter implements ExceptionFilter {
  catch(_: PayloadTooLargeException, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(413).json({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'file_info.import_err_too_large',
    });
  }
}
