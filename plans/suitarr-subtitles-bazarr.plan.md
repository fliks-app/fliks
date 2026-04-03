# Suitarr — Plan Subtitles (equivalent Bazarr)

## Objectif

Integrer la gestion des sous-titres directement dans Suitarr, sans dependance externe a Bazarr. Le systeme doit pouvoir rechercher, telecharger, upgrader et synchroniser automatiquement les sous-titres pour les films et series geres par Suitarr.

---

## Phase 1 : Backend — Fondations (entites, providers, service)

### 1.1 Enums & constantes

- [x] `SubtitleLanguage` — couvert par `suitarr-languages.ts` existant (ISO 639-1)
- [x] `SubtitleProviderType` — enum : `OPENSUBTITLES`, `SUBSCENE`, `SOUS_TITRES_EU`, `SUBDL`, `SUBSYNCHRO`, `SUPERSUBTITLES`, `WHISPER` (extensible)
- [x] `SubtitleStatus` — enum : `MISSING`, `DOWNLOADED`, `UPGRADED`, `SYNCED`, `FAILED`

### 1.2 Entites TypeORM

- [x] **SubtitleProvider** (`subtitle_providers`)
  - `id`, `name`, `type: SubtitleProviderType`, `enabled: boolean`
  - `settings: jsonb` (apiKey, username, password, baseUrl — selon le provider)
  - `priority: number`, `tags: Tag[] (M2M)`
  - Relations standard BaseEntity (createdAt, updatedAt)

- [x] **Refactoring LanguageProfile** (`language_profiles`) — remplace l'ancien modele cutoff/allowed
  - `id`, `name`
  - `audioLanguages: jsonb` — array `{ isoCode: string, name: string }[]` (facultatif, vide = pas de filtre audio)
  - `subtitleLanguages: jsonb` — array `{ isoCode: string, name: string, forced: boolean, hi: boolean }[]`
  - Un profil unifie qui definit : quelles langues audio accepter pour les releases ET quels sous-titres telecharger automatiquement

- [x] **SubtitleFile** (`subtitle_files`)
  - `id`, `mediaId: FK Media`, `episodeId?: FK Episode` (null pour films)
  - `mediaFileId: FK MediaFile`
  - `language: string` (ISO 639-1)
  - `forced: boolean`, `hearingImpaired: boolean`
  - `providerType: SubtitleProviderType`, `providerFileId: string`
  - `filePath: string`, `status: SubtitleStatus`
  - `score: number` (qualite du match, 0-100)
  - `synced: boolean`, `syncOffset?: number` (ms)

- [x] **Pas de nouvelle colonne sur Media** — le `languageProfileId` existant couvre desormais audio + sous-titres

### 1.3 Providers (pattern existant Indexers/DownloadClients)

Creer un dossier `modules/subtitles/providers/` avec une interface commune :

```typescript
interface SubtitleProviderInterface {
  search(params: SubtitleSearchParams): Promise<SubtitleSearchResult[]>;
  download(result: SubtitleSearchResult): Promise<Buffer>;
  testConnection(settings: Record<string, any>): Promise<boolean>;
}
```

- [x] **OpenSubtitlesProvider** — REST API v2 (opensubtitles.com/docs)
  - Auth via API key + token
  - Search par hash fichier + IMDB ID + nom
  - Download avec decompte quotidien
- [x] **SubdlProvider** — API REST (subdl.com), recherche par IMDB ID / titre, bonne couverture multi-langues
- [x] **SubsynchroProvider** — specialise sous-titres francais (subsynchro.com)
- [x] **SupersubtitlesProvider** — provider complementaire (supersubtitles.com)
- [x] **SubtitleProviderFactory** — factory qui instancie le bon provider selon `SubtitleProviderType`

### 1.4 Services

- [x] **SubtitlesService** (`subtitles.service.ts`)
  - `searchSubtitles(mediaId, episodeId?, language?)` — interroge les providers actifs par priorite
  - `downloadSubtitle(searchResult)` — telecharge, sauve sur disque, cree SubtitleFile
  - `deleteSubtitle(subtitleFileId)` — supprime fichier + entite
  - `upgradeSubtitle(subtitleFileId, newResult)` — remplace par meilleur score
  - `getSubtitlesForMedia(mediaId)` — liste tous les sous-titres

- [x] **SubtitleSyncService** (`subtitle-sync.service.ts`)
  - `syncSubtitle(subtitleFileId)` — ajuste le timing via ffsubsync ou alass (CLI externe)
  - `reencodeToUtf8(filePath)` — re-encode en UTF-8 si necessaire

- [x] **SubtitleProviderService** (`subtitle-provider.service.ts`)
  - CRUD des providers configures (similaire a IndexersService)
  - `testProvider(id)` — test de connexion

- [x] **Refactoring LanguageProfileService** — adapter le CRUD existant pour gerer audioLanguages + subtitleLanguages au lieu de l'ancien modele cutoff/allowed

### 1.5 Module NestJS

- [x] `SubtitlesModule` importe : TypeOrmModule (SubtitleProvider, SubtitleFile, Tag), AuthModule
- [x] Exporte : SubtitlesService, SubtitleProviderService, SubtitleSyncService (pour usage dans scheduler et controller)

---

## Phase 2 : Backend — Controller & API REST

### 2.1 SubtitlesController (`/api/subtitles`)

- [x] `GET /api/subtitles/providers` — liste des providers configures
- [x] `POST /api/subtitles/providers` — creer un provider
- [x] `PUT /api/subtitles/providers/:id` — modifier un provider
- [x] `DELETE /api/subtitles/providers/:id` — supprimer un provider
- [x] `POST /api/subtitles/providers/:id/test` — test de connexion

- [x] Endpoints `/api/profiles/language` existants — adapter pour le nouveau schema (audioLanguages + subtitleLanguages)

### 2.2 Endpoints sur MediaController (extension)

- [x] `GET /api/media/:id/subtitles` — sous-titres existants pour un media
- [x] `GET /api/media/:id/subtitles/search` — recherche manuelle (params: language, episodeId)
- [x] `POST /api/media/:id/subtitles/download` — telecharger un sous-titre (body: searchResult)
- [x] `DELETE /api/media/:id/subtitles/:subtitleId` — supprimer un sous-titre
- [x] `POST /api/media/:id/subtitles/:subtitleId/sync` — synchroniser timing
- [x] `POST /api/media/:id/subtitles/:subtitleId/upgrade` — forcer un upgrade

### 2.3 Authorization CASL

- [x] Ajouter subject `SubtitleProvider` + `SubtitleFile` dans CaslAbilityFactory
- [x] ADMIN : manage all
- [x] USER : peut search/download/delete des sous-titres sur les medias qu'il gere
- [x] READONLY : peut voir les sous-titres existants

---

## Phase 3 : Backend — Scheduler & automatisation

### 3.1 Taches planifiees (dans SchedulerModule existant)

- [x] **SubtitleSearchJob** — cron toutes les 6h (`SubtitleSchedulerService.searchMissingSubtitles`)
  - Scan tous les medias monitores dont le LanguageProfile a des subtitleLanguages
  - Pour chaque MediaFile sans sous-titre dans les langues du profil → search + download auto
  - Respecte le score minimum configurable, auto-sync et UTF-8 encode

- [x] **SubtitleUpgradeJob** — cron toutes les 12h (`SubtitleSchedulerService.upgradeSubtitles`)
  - Pour chaque SubtitleFile avec score < seuil upgrade
  - Re-search et remplace si meilleur score trouve

- [x] **Post-download hook** — dans `CompletionService.importCompleted()`
  - Apres import d'un MediaFile, appel `onMediaFileImported()` qui declenche recherche de sous-titres

### 3.2 Settings supplementaires (AppSetting)

- [x] `subtitle_auto_search` — "true"/"false" (defaut: true)
- [x] `subtitle_search_interval` — lu dans scheduler (defaut: 360)
- [x] `subtitle_upgrade_interval` — lu dans scheduler (defaut: 720)
- [x] `subtitle_min_score` — score minimum pour auto-download (defaut: 70)
- [x] `subtitle_upgrade_threshold` — score en dessous duquel on cherche un upgrade (defaut: 90)
- [x] `subtitle_auto_sync` — synchronisation auto apres download (defaut: false)
- [x] `subtitle_encode_utf8` — re-encode auto en UTF-8 (defaut: true)

### 3.3 Notifications

- [x] Ajouter events : `subtitle.downloaded`, `subtitle.upgraded`, `subtitle.failed`
- [x] Envoyer notifications via les NotificationConnection existantes

---

## Phase 4 : Frontend — Settings

### 4.1 Page Settings > Subtitle Providers

- [x] Route `/settings/subtitle-providers` (lazy-loaded)
- [x] Liste des providers avec toggle enabled/disabled
- [x] Modale ajout/edition avec champs dynamiques selon le type (similaire indexers)
- [x] Bouton "Test" avec feedback visuel
- [x] API service `subtitle-providers-api.service.ts`

### 4.2 Refactoring Page Settings > Language Profiles

- [x] Adapter la page existante `/settings/language-profiles` pour le nouveau schema
- [x] Section "Audio Languages" — multi-select des langues acceptees (vide = pas de filtre)
- [x] Section "Subtitle Languages" — multi-select avec toggles forced/HI par langue
- [x] Supprimer le concept cutoff/allowed de l'UI

### 4.3 Page Settings > Subtitles (general)

- [x] Route `/settings/subtitles` (lazy-loaded)
- [x] Options : auto search, intervals, score min, upgrade threshold, auto sync, UTF-8 encode
- [x] Utilise le SettingsApiService existant

### 4.4 Navigation

- [x] Ajouter les 2 sous-routes dans le menu Settings existant (subtitle-providers, subtitles)
- [x] Language Profiles deja present dans le menu

---

## Phase 5 : Frontend — Integration Media

### 5.1 Section sous-titres dans Media Detail

- [x] Onglet/section "Subtitles" dans la page media-detail
- [x] Tableau des sous-titres existants par fichier :
  - Langue, provider, score, status, forced, HI
  - Actions : sync, delete
- [x] Bouton "Search Subtitles" → modale de recherche manuelle
- [x] Modale de recherche : liste resultats avec score, provider, langue, bouton download

### 5.2 Integration via LanguageProfile existant

- [x] Le LanguageProfile assigne au media determine automatiquement les sous-titres a chercher (via subtitleLanguages)
- [x] Si `subtitleLanguages` est vide dans le profil → pas de recherche auto de sous-titres pour ce media

### 5.3 Indicateurs visuels

- [ ] Badge sur la media-card quand sous-titres manquants (point orange)
- [ ] Badge quand sous-titres complets (checkmark vert)
- [ ] Filtre "Missing Subtitles" dans les listes movies/series

### 5.4 API service frontend

- [x] `subtitles-api.service.ts` — search, download, delete, sync, upgrade
- [x] Integre dans les composants media-detail et modales

---

## Phase 6 : Activite & monitoring

### 6.1 Page Activity

- [x] Onglet "Subtitles" dans la page activity existante
- [x] Historique des telechargements de sous-titres (date, media, langue, provider, score, status)
- [x] Filtres par status, langue

### 6.2 Dashboard

- [x] Widget "Subtitles" sur le dashboard :
  - Compteurs total/downloaded/failed/synced
  - Derniers sous-titres telecharges (table)
  - Stats par provider et status via endpoint `/api/subtitles/stats`

### 6.3 System Health

- [x] Health check endpoint `/api/subtitles/health` pour les subtitle providers
- [x] Test connexion de chaque provider enabled, retourne ok/error

---

## Phase 7 : Traductions i18n

- [x] Clés FR ajoutées dans `fr.json` :
  - `settings.nav.subtitle_providers`, `settings.nav.subtitles`
  - `settings.language_profiles.*` (mis à jour pour audio/subtitle)
  - `settings.subtitle_providers.*` (CRUD complet)
  - `settings.subtitles.*` (options auto search, upgrade, sync, UTF-8)
  - `media_detail.subtitles_section`, `media_detail.search_subtitles`, `media_detail.col_sub_*`
  - `activity.tab_subtitles`, `activity.col_language`, `activity.col_provider`, filtres
  - `dashboard.subtitles_title`, `dashboard.sub_*`

---

## Ordre d'implementation recommande

| Etape | Phases | Description |
|-------|--------|-------------|
| 1 | 1.1–1.2 | Enums, entites, migration DB |
| 2 | 1.3–1.5 | Providers, services, module |
| 3 | 2.1–2.3 | Controller, API REST, CASL |
| 4 | 4.1–4.4 | Frontend settings (providers, profiles, general) |
| 5 | 5.1–5.4 | Frontend integration media-detail |
| 6 | 3.1–3.3 | Scheduler, automatisation, notifications |
| 7 | 6.1–6.3 | Activity, dashboard, health |
| 8 | 7 | Traductions completes |

---

## Estimation de scope

- ~15 fichiers backend nouveaux (entites, services, controller, providers, DTOs)
- ~10 fichiers frontend nouveaux (pages settings, composants, services API)
- ~5 fichiers existants modifies (Media entity, media-detail, app.routes, settings routes, scheduler, CASL, notifications)
- Migration TypeORM pour les 3 nouvelles tables + colonne sur Media

## Providers prioritaires (v1)

1. **OpenSubtitles** — le plus complet, API REST moderne
2. **Subdl** — API REST, bonne couverture multi-langues
3. **Subsynchro** — specialise francais, pertinent pour les utilisateurs FR
4. **Supersubtitles** — provider complementaire

Les autres providers pourront etre ajoutes iterativement grace au pattern factory.
