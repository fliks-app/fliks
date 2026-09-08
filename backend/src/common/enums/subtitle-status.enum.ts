export enum SubtitleStatus {
  MISSING = 'missing',
  DOWNLOADED = 'downloaded',
  UPGRADED = 'upgraded',
  SYNCED = 'synced',
  FAILED = 'failed',
  /** The file is on disk and servable; only shifting its timing failed. Every
   *  guard that drops a FAILED row keeps this one, on purpose. */
  SYNC_FAILED = 'sync_failed',
  EMBEDDED = 'embedded',
  /** OCR extraction of an image-based subtitle is running in the background */
  PROCESSING = 'processing',
}
