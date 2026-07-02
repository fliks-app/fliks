/**
 * Release-name parsing utilities — pure functions that extract structured
 * information (quality, language, season/episode, codec, release group …)
 * from a raw release name. Domain-agnostic on purpose: they are consumed
 * by the auto-grab pipeline, the subtitle scorer, the file rescan, and
 * the orphaned-torrent auto-matcher. None of them touch the DB.
 */
export * from './attributes.parser';
export * from './language.parser';
export * from './quality.parser';
export * from './quality-from-resolution';
export * from './season-episode.parser';
export * from './title.extractor';
