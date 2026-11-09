import { Component, inject } from '@angular/core';
import { map } from 'rxjs';
import { SseService } from '../../core/services/sse.service';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { DataTableComponent } from '../../shared/components/data-table/data-table';
import type { TableRow } from '../../shared/components/data-table/data-table.types';
import { isMediaKind, mediaDetailLink } from '../../core/media-kinds';
import {
  HISTORY_ACTIONS,
  HISTORY_COLUMNS,
  HISTORY_FILTERS,
  HISTORY_LIST_ACTIONS,
  HISTORY_URL,
  QUEUE_ACTIONS,
  QUEUE_COLUMNS,
  QUEUE_URL,
  REFRESH_ON,
} from './acquisition-queue.config';

/** The core-owned queue and history of every download provider (`route.data.view`). */
@Component({
  selector: 'app-acquisition-queue',
  imports: [TranslatePipe, DataTableComponent],
  templateUrl: './acquisition-queue.html',
})
export class AcquisitionQueueComponent {
  private readonly router = inject(Router);

  protected readonly isHistory = inject(ActivatedRoute).snapshot.data['view'] === 'history';
  protected readonly queueUrl = QUEUE_URL;
  protected readonly queueColumns = QUEUE_COLUMNS;
  protected readonly queueActions = QUEUE_ACTIONS;
  protected readonly historyUrl = HISTORY_URL;
  protected readonly historyColumns = HISTORY_COLUMNS;
  protected readonly historyFilters = HISTORY_FILTERS;
  protected readonly historyActions = HISTORY_ACTIONS;
  protected readonly historyListActions = HISTORY_LIST_ACTIONS;
  protected readonly refreshOn = REFRESH_ON;
  /** `rows` of a provider's report patch the queue; a report without them (many changes) reloads it. */
  protected readonly rowPatches = inject(SseService).queueEvents.pipe(
    map((e) => {
      const rows = (e['payload'] as { rows?: unknown } | undefined)?.rows;
      return Array.isArray(rows) ? (rows as TableRow[]) : null;
    }),
  );

  /** The title cell opens the row's media page; no media type, no link. */
  protected readonly resolveAction = (
    actionId: string,
    row: TableRow,
  ): (() => void) | undefined => {
    const type = row['mediaType'];
    if (actionId !== 'table.open-media' || row['mediaId'] == null || !isMediaKind(type)) {
      return undefined;
    }
    const url = mediaDetailLink(type, String(row['mediaId'])).join('/');
    return () => {
      void this.router.navigateByUrl(url);
    };
  };
}
