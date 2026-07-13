/**
 * Who can read a playlist.
 * - `PRIVATE`: the owner (and explicit shares) only.
 * - `FOLLOWERS`: the owner's accepted followers.
 * - `PUBLIC`: any authenticated member.
 */
export enum PlaylistVisibility {
  PRIVATE = 'private',
  FOLLOWERS = 'followers',
  PUBLIC = 'public',
}
