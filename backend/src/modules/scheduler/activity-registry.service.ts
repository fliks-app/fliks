import { Injectable } from '@nestjs/common';
import { EventsService } from './events.service';
import type { MediaProgressSubject } from '../../common/utils/media-progress-subject.util';

export type ActivityStatus = 'running' | 'pending';

export interface ActivityEntry {
  id: string;
  type: string;
  subject?: MediaProgressSubject;
  status: ActivityStatus;
  current?: number;
  total?: number;
}

interface StoredEntry extends ActivityEntry {
  /** Insertion order, kept across a pending→running transition (same `id`) so a
   *  row never jumps position within its status group between refetches. */
  seq: number;
}

/** A library import can mutate the registry many times a second; collapsing that
 *  into one change ping every so often keeps the SSE stream from turning into a
 *  frame-per-mutation firehose. */
const BROADCAST_DEBOUNCE_MS = 250;

/** Defensive cap, so a pathological queue must not grow this (and its per-list sort)
 *  without bound. Real workloads (a season import, a library sweep) sit far below it. */
const MAX_ENTRIES = 2000;

/**
 * Single source of truth for "what is the server doing right now": running work
 * plus whatever is queued behind it. Producers (the sprite/subtitle/enrichment
 * queues, the long scheduler loops) upsert as work is queued/starts/progresses and
 * remove it in a `finally`, so an entry can never outlive its task.
 *
 * Purely additive to the existing `task.progress` SSE stream, which keeps driving
 * the import banner and orphan-scan panel untouched. This registry has no payload
 * of its own on the wire: it emits a payload-free `activity.changed` ping and the
 * System page fetches the paginated list from `GET /api/system/activity`.
 */
@Injectable()
export class ActivityRegistryService {
  private readonly entries = new Map<string, StoredEntry>();
  private nextSeq = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly events: EventsService) {}

  upsertPending(id: string, type: string, subject?: MediaProgressSubject): void {
    this.upsert(id, { id, type, subject, status: 'pending' });
  }

  upsertRunning(
    id: string,
    type: string,
    subject?: MediaProgressSubject,
    current?: number,
    total?: number,
  ): void {
    this.upsert(id, { id, type, subject, status: 'running', current, total });
  }

  remove(id: string): void {
    if (!this.entries.delete(id)) return;
    this.scheduleBroadcast();
  }

  /** Running rows first, then pending; stable enqueue order inside each group.
   *  The sort applies before pagination, so page 1 always shows what is actually
   *  executing and a page number keeps meaning the same thing across a refetch. */
  list(page: number, limit: number): { data: ActivityEntry[]; total: number } {
    const ordered = [...this.entries.values()].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return a.seq - b.seq;
    });
    const start = (page - 1) * limit;
    const data: ActivityEntry[] = ordered
      .slice(start, start + limit)
      .map((e) => ({
        id: e.id,
        type: e.type,
        subject: e.subject,
        status: e.status,
        current: e.current,
        total: e.total,
      }));
    return { data, total: ordered.length };
  }

  private upsert(id: string, entry: ActivityEntry): void {
    const existing = this.entries.get(id);
    if (!existing && this.entries.size >= MAX_ENTRIES) return;
    this.entries.set(id, { ...entry, seq: existing?.seq ?? this.nextSeq++ });
    this.scheduleBroadcast();
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.events.emit({ type: 'activity.changed' });
    }, BROADCAST_DEBOUNCE_MS);
  }
}
