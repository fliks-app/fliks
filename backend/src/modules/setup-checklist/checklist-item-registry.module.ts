import { Module } from '@nestjs/common';
import { ChecklistItemRegistry } from './checklist-item-registry.service';

/** Standalone so a detachable bundle can register into it without importing
 *  `SetupChecklistModule` — keeps bundle wiring out of that module. */
@Module({
  providers: [ChecklistItemRegistry],
  exports: [ChecklistItemRegistry],
})
export class ChecklistItemRegistryModule {}
