export enum SubtitleStatus {
  MISSING = 'missing',
  DOWNLOADED = 'downloaded',
  UPGRADED = 'upgraded',
  SYNCED = 'synced',
  FAILED = 'failed',
  EMBEDDED = 'embedded',
  /** OCR extraction of an image-based subtitle is running in the background */
  PROCESSING = 'processing',
}
