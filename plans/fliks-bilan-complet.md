# Fliks — Bilan complet des travaux

## Batch 1 : Limites de poids, seeders min, rejections

### Fait
- [x] Limites de poids par qualite (min/preferred/max en MB) dans `QualityProfileItem`
- [x] Seeders minimum par indexeur (stocke dans `settings.minSeeders`)
- [x] Rejections typees (`ReleaseRejection[]` avec codes machine + params i18n)
- [x] Indicateur de rejet dans les 4 tables de releases (tooltip DaisyUI `tooltip-content` avec `<ul>`)
- [x] Inputs min/preferred/max dans l'editeur de profil de qualite
- [x] Traductions FR completes

### Refactoring applique
- [x] Extraction `release-rejection.helper.ts` (computeRejections, buildSizeByQuality, buildIndexerMinSeeders, buildAllowedQualityIds)
- [x] preferredSize utilise (warning SIZE_NOT_PREFERRED quand ecart > 30%)
- [x] Codes machine au lieu de strings FR dans le backend
- [x] Tooltip DaisyUI avec `<div class="tooltip-content">` au lieu de `data-tip`
- [x] Constante `EMPTY_LIMITS` pour getSizeLimit fallback
- [x] Validation coherence min <= preferred <= max (DTO backend + UI frontend)
- [x] sanitizeSettings() pour minSeeders dans IndexersService

---

## Batch 2 : Features Radarr/Sonarr de base (11 features)

### Fait
- [x] **Quota enforcement** — `checkQuota()` dans `requests.service.ts` avant create()
- [x] **Filtres missing/cutoff-unmet** — DTO + applyFilters SQL + post-filtrage cutoff + dropdown frontend movies+series
- [x] **Custom search query** — `@Query('q')` sur endpoints releases, input dans la modale, passe a searchMovieReleases/searchEpisodeReleases
- [x] **Categories par type** — `addTorrentUrl(client, url, mediaType)`, movieCategory/seriesCategory dans settings download client
- [x] **Minimum availability** — enum `MinimumAvailability`, colonne sur Media, `isAvailable()` dans scheduler
- [x] **Auto-blocklist + retry** — `blocklist.create()` dans le catch de completion.service.ts
- [x] **Remote path mappings** — entite + CRUD + `translatePath()` dans completion + page settings frontend
- [x] **Bulk editing** — `PATCH /media/bulk` + checkboxes + toolbar sticky dans movies/series
- [x] **Discover trending/popular/upcoming** — 6 endpoints TMDB + tabs DaisyUI dans discover
- [x] **Delay profiles** — entite + `pubDate` parsing torznab + `isDelayed()` dans RSS sync + page settings
- [x] **Backup/Restore** — BackupService (pg_dump) + endpoints system + UI frontend

---

## Batch 3 : Features UX avancees (11 features)

### Fait
- [x] **Dark/light theme toggle** — signal `theme` + localStorage + `data-theme` + bouton sun/moon dans layout
- [x] **Test/preview custom formats** — `POST /custom-formats/test` + breakdown par format + UI input/table
- [x] **Quality grouping** — `groupId` dans QualityProfileItem + `buildAllowedQualityIds()` group-aware + bouton "grouper avec precedent" dans UI
- [x] **Indexer flags freeleech** — `downloadvolumefactor` parse dans torznab + `freeleech`/`downloadVolumeFactor` dans releases + custom format spec `indexer_flag` + badge FL dans les 4 tables
- [x] **Log viewer** — `LogBufferService` (ring buffer 2000 entries) + `GET /system/logs` + UI avec filtre niveau/recherche + auto-refresh 5s
- [x] **Indexer stats** — `IndexerStat` entite + timing dans torznab + `GET /indexers/:id/stats` agrege 30j + modale stats
- [x] **Rename & organize** — `POST /media/:id/rename` + NamingService dans MediaModule + bouton dans section fichiers
- [x] **Post-import scripts** — execution script apres import avec env vars (FLIKS_MEDIA_TITLE, FILE_PATH, etc.) + input dans settings general
- [x] **SSE task progress** — `EventsService` + `@Sse('events')` + `SseService` frontend (EventSource) + barres de progression dans system
- [x] **Migration Radarr/Sonarr** — ImportRadarrService/ImportSonarrService (sql.js) + upload endpoints + UI dans system
- [x] **PWA** — manifest.webmanifest + meta theme-color + link manifest dans index.html

### Reste a faire (etapes manuelles)
- [ ] `cd backend && npm install sql.js` — installer la dependance pour l'import Radarr/Sonarr
- [ ] Creer `frontend/public/icons/` avec icon-192x192.png et icon-512x512.png pour le PWA
- [ ] Optionnel : `ng add @angular/pwa` pour le service worker complet (ngsw-config.json)

---

## Plans pour plus tard

### Jellyseerr
- Issue reporting (entite Issue, CRUD, notifications admin)
- Integration media server (Jellyfin/Plex/Emby — auth, sync bibliotheque, badge "disponible")
- Quota dashboard utilisateur
- Discover avec recommandations TMDB

### Radarr/Sonarr avance
- **Import lists** (Trakt/IMDB/TMDB Lists) — entite ImportList + providers + cron sync
- **Usenet** (SABnzbd/NZBGet) — nouveau service client + flow completion parallele
- **Exclusion list** — entite Exclusion(tmdbId) + check dans RSS/search/import
- **Recycle bin** — move au lieu de delete + cron cleanup 7 jours
- **Torrent blackhole** — BlackholeService : .torrent → watch folder + scan periodique
- **Multi-audio detection** — title parsing MULTI/DUAL/VFF + post-import ffprobe

---

## Stats

| Batch | Fichiers modifies | Fichiers crees | Lignes ajoutees |
|-------|:-:|:-:|:-:|
| 1 (poids/seeders/rejections) | 15 | 1 | ~400 |
| 2 (Radarr/Sonarr base) | 45 | 15 | ~1500 |
| 3 (UX avancees) | ~65 | ~35 | ~3000 |
| **Total** | **~125** | **~51** | **~4900** |
