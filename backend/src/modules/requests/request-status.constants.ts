import { RequestStatus } from '../../common/enums';
import { FliksRequest } from './entities/request.entity';

/** Statuses that count as "this user already wants this title".
 *  Pending: awaiting decision. Approved/Processing: the system is on it.
 *  Available: already delivered. All four block a same-user re-request. */
export const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = [
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.PROCESSING,
  RequestStatus.AVAILABLE,
] as const;

/** Statuses on which another user's request can satisfy a new one — the
 *  resulting media is (or will be) downloaded under those profiles. */
export const SATISFIABLE_REQUEST_STATUSES: readonly RequestStatus[] = [
  RequestStatus.APPROVED,
  RequestStatus.PROCESSING,
  RequestStatus.AVAILABLE,
] as const;

/** Statuses still in motion — the lifecycle can still mutate them. */
export const IN_FLIGHT_REQUEST_STATUSES: readonly RequestStatus[] = [
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.PROCESSING,
] as const;

/** Resolve a request's season scope to a normalised representation:
 *  - `null` → covers everything (movie or whole-series).
 *  - `Set<number>` → covers exactly these season numbers. */
export function seasonScopeOf(
  request: Pick<FliksRequest, 'seasons'>,
): Set<number> | null {
  if (!request.seasons || request.seasons.length === 0) return null;
  return new Set(request.seasons);
}
