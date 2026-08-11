export enum Action {
  Manage = 'manage',
  Create = 'create',
  Read = 'read',
  Update = 'update',
  Delete = 'delete',
  Approve = 'approve',
  Decline = 'decline',
  Grab = 'grab',
  /** Read-only visibility into a media's acquisition progress — kept distinct from
   *  `Read` so it doesn't imply full media.read access. */
  Track = 'track',
}
