import { Global, Module } from '@nestjs/common';
import { FileTransferService } from './services/file-transfer.service';

/**
 * Cross-cutting helpers that don't fit any particular feature module. Marked
 * `@Global()` so feature modules don't have to re-import it explicitly to
 * inject `FileTransferService` etc.
 */
@Global()
@Module({
  providers: [FileTransferService],
  exports: [FileTransferService],
})
export class CommonModule {}
