export enum SubtitleProviderType {
  OPENSUBTITLES = 'opensubtitles',
  SUBSCENE = 'subscene',
  SOUS_TITRES_EU = 'sous_titres_eu',
  SUBDL = 'subdl',
  SUBSYNCHRO = 'subsynchro',
  SUPERSUBTITLES = 'supersubtitles',
  WHISPER = 'whisper',
  YIFY = 'yify',
  GESTDOWN = 'gestdown',
  EMBEDDED = 'embedded',
  /** External subtitle files discovered via Radarr API import (extra files) */
  RADARR = 'radarr',
  /** External subtitle files discovered via Sonarr API import */
  SONARR = 'sonarr',
  /** External subtitle files discovered on disk during rescan */
  DISK = 'disk',
  /** Text subtitle produced by OCR'ing an image-based (burn-required) track */
  OCR = 'ocr',
}
