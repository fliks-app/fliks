import { Injectable, Logger } from '@nestjs/common';
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
  /** Groups this row under another entry's id. Ignored once that id is gone
   *  from the registry: the row surfaces as top-level instead of vanishing. */
  parentId?: string;
}

/** A top-level row as served by `list()`: its children (if any) travel inline
 *  so a parent and its backlog are always paginated as one unit. */
export interface ActivityRow extends ActivityEntry {
  children?: ActivityEntry[];
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

/** Defensive cap. A bulk command now pre-registers its whole backlog (every file/season
 *  it will touch) as pending up front, so this has to comfortably clear a real library's
 *  file count, not just the small number that happens to be running at once. */
const MAX_ENTRIES = 20_000;

/**
 * Single source of truth for "what is the server doing right now": running work
 * plus whatever is queued behind it. Producers (the sprite/subtitle/enrichment
 * queues, the long scheduler loops) upsert as work is queued/starts/progresses and
 * remove it in a `finally`, so an entry can never outlive its task.
 *
 * A row may declare a `parentId` (another entry's id) to nest under it: a bulk
 * command and the per-file/per-season jobs it spawns. `list()` groups children
 * under their parent inline and paginates over top-level rows only, so a parent
 * and its backlog always land on the same page.
 *
 * Purely additive to the existing `task.progress` SSE stream, which keeps driving
 * the import banner and orphan-scan panel untouched. This registry has no payload
 * of its own on the wire: it emits a payload-free `activity.changed` ping and the
 * System page fetches the paginated list from `GET /api/system/activity`.
 */
@Injectable()
export class ActivityRegistryService {
  private readonly log = new Logger(ActivityRegistryService.name);
  private readonly entries = new Map<string, StoredEntry>();
  private nextSeq = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lifetime count of registrations rejected because the cap was full. Never
   *  silent: logged once, then surfaced on every `list()` response. */
  private dropped = 0;
  private capWarningLogged = false;

  constructor(private readonly events: EventsService) {}

  upsertPending(
    id: string,
    type: string,
    subject?: MediaProgressSubject,
    parentId?: string,
  ): void {
    this.upsert(id, { id, type, subject, status: 'pending' }, parentId);
  }

  upsertRunning(
    id: string,
    type: string,
    subject?: MediaProgressSubject,
    current?: number,
    total?: number,
    parentId?: string,
  ): void {
    this.upsert(
      id,
      { id, type, subject, status: 'running', current, total },
      parentId,
    );
  }

  remove(id: string): void {
    if (!this.entries.delete(id)) return;
    this.scheduleBroadcast();
  }

  /**
   * Running rows first, then pending; stable enqueue order inside each group,
   * applied at top level and, separately, among each parent's children. A child
   * whose parent id isn't (or is no longer) in the registry surfaces as its own
   * top-level row rather than being dropped, so a parent that finishes or is
   * removed while children are still running never orphans them into invisibility.
   *
   * Pagination counts top-level rows (a parent + its children are one unit), so
   * `limit` groups per page, never a page boundary landing mid-group.
   */
  list(page: number, limit: number): { data: ActivityRow[]; total: number; dropped: number } {
    const childrenByParent = new Map<string, StoredEntry[]>();
    const topLevel: StoredEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.parentId && this.entries.has(entry.parentId)) {
        const siblings = childrenByParent.get(entry.parentId);
        if (siblings) siblings.push(entry);
        else childrenByParent.set(entry.parentId, [entry]);
      } else {
        topLevel.push(entry);
      }
    }

    const orderedTop = sortByStatusThenSeq(topLevel);
    const start = (page - 1) * limit;
    const data: ActivityRow[] = orderedTop.slice(start, start + limit).map((e) => {
      const kids = childrenByParent.get(e.id);
      return {
        ...toPublic(e),
        children: kids?.length ? sortByStatusThenSeq(kids).map(toPublic) : undefined,
      };
    });
    return { data, total: orderedTop.length, dropped: this.dropped };
  }

  private upsert(
    id: string,
    entry: ActivityEntry,
    parentId: string | undefined,
  ): void {
    const existing = this.entries.get(id);
    if (!existing && this.entries.size >= MAX_ENTRIES) {
      this.dropped++;
      if (!this.capWarningLogged) {
        this.capWarningLogged = true;
        this.log.warn(
          `Activity registry at capacity (${MAX_ENTRIES}): "${id}" (and further registrations) will not appear until the registry drains`,
        );
      }
      return;
    }
    this.entries.set(id, {
      ...entry,
      parentId: parentId ?? existing?.parentId,
      seq: existing?.seq ?? this.nextSeq++,
    });
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

function sortByStatusThenSeq(list: StoredEntry[]): StoredEntry[] {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
    return a.seq - b.seq;
  });
}

function toPublic(e: StoredEntry): ActivityEntry {
  return {
    id: e.id,
    type: e.type,
    subject: e.subject,
    status: e.status,
    current: e.current,
    total: e.total,
    parentId: e.parentId,
  };
}
