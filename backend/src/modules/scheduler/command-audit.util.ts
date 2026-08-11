import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Command } from './entities/command.entity';
import { EventsService } from './events.service';

/**
 * Wraps `fn` in a `Command` row (running → completed/failed) plus the matching
 * `command.started`/`command.completed` events. Shared by core's own scheduled
 * jobs (`SchedulerService`) and the download bundle's two audited crons —
 * neither depends on the other to get it.
 */
export async function runAuditedCommand(
  commandRepo: Repository<Command>,
  eventsService: EventsService,
  name: string,
  trigger: string,
  fn: () => Promise<void>,
  logger: Logger,
): Promise<void> {
  const cmd = await commandRepo.save(
    commandRepo.create({
      name,
      status: 'running',
      trigger,
      startedOn: new Date(),
    }),
  );
  eventsService.emit({ type: 'command.started', name });
  try {
    await fn();
    cmd.status = 'completed';
  } catch (e) {
    logger.error(`Command ${name} error: ${(e as Error).message}`);
    cmd.status = 'failed';
  } finally {
    cmd.endedOn = new Date();
    await commandRepo.save(cmd);
    eventsService.emit({ type: 'command.completed', name, status: cmd.status });
  }
}
