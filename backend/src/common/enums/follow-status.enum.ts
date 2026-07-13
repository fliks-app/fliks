/**
 * State of a follow edge. A follow of a public profile is created directly as
 * `ACCEPTED`; a follow of a private profile starts `PENDING` until the target
 * accepts it.
 */
export enum FollowStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
}
