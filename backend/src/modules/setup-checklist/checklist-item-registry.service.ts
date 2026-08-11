import { Injectable } from '@nestjs/common';

export type ChecklistItemSeverity = 'required' | 'recommended';

export interface ChecklistItemDef {
  key: string;
  severity: ChecklistItemSeverity;
  /** Frontend route segments to navigate to when the user clicks "Configure". */
  route: string[];
  check: () => Promise<boolean>;
}

/**
 * Lets a detachable bundle publish setup-checklist items without core naming
 * or importing the bundle's entities. Mirrors `ScheduledJobRegistry`'s
 * shape; empty when the owning bundle isn't loaded.
 */
@Injectable()
export class ChecklistItemRegistry {
  private readonly items = new Map<string, ChecklistItemDef>();

  register(items: readonly ChecklistItemDef[]): void {
    for (const item of items) this.items.set(item.key, item);
  }

  list(): ChecklistItemDef[] {
    return [...this.items.values()];
  }
}
