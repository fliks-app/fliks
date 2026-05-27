import { DataSource } from 'typeorm';

/**
 * Enqueue a scheduler command via a direct INSERT. Used by code paths that
 * can't inject `SchedulerService` without a circular module dependency
 * (completion / stalled-cleanup, download-clients block action). The scheduler
 * picks `queued` rows up on its next tick.
 */
export function enqueueCommand(
  dataSource: DataSource,
  name: string,
  body: Record<string, unknown>,
  trigger: 'scheduled' | 'manual' = 'manual',
): Promise<unknown> {
  return dataSource.query(
    `INSERT INTO commands (name, status, trigger, body) VALUES ($1, 'queued', $2, $3)`,
    [name, trigger, JSON.stringify(body)],
  );
}
