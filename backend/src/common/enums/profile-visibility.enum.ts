/**
 * How discoverable a user's social profile is. Both values are findable in
 * member search; they differ in how following works and what a non-follower
 * sees.
 * - `PUBLIC`: anyone can follow instantly and see the shared content.
 * - `PRIVATE`: following needs approval; a non-follower sees only name + avatar.
 */
export enum ProfileVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
}
