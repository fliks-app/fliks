# Download Lifecycle

## Vue d'ensemble

```
Client                              Serveur                           Fichier serveur
  │                                   │                                 │
  ├─ POST /downloads ────────────────►│ Crée DownloadTask               │
  │  { mediaFileId, quality,          │                                 │
  │    deviceProfile }                │                                 │
  │                                   │                                 │
  │  quality = 'original'             │ status = 'pending'              │
  │    source SDR ──────────────────► │ → remux (video copy + AAC)      │ dl-{id}-remux.mp4
  │    source HDR + client SDR ─────► │ → transcode avec tonemap        │ dl-{id}-{quality}.mp4
  │    source HDR + client HDR ─────► │ → remux (video copy + AAC)      │ dl-{id}-remux.mp4
  │  quality = '720p' ──────────────► │ → transcode complet             │ dl-{id}-720p.mp4
  │                                   │                                 │
  │  ◄──── SSE download.progress ─────┤ progress = 45%                  │ (en cours d'écriture)
  │  ◄──── SSE download.ready ────────┤ status = 'ready'                │ (MP4 + VTT subs)
  │                                   │                                 │
  ├─ GET /downloads/{id}/file ───────►│ Sert le MP4                     │
  ├─ GET /downloads/{id}/subtitle/… ─►│ Sert les fichiers VTT           │
  │  (stream vers device)             │                                 │
  │                                   │                                 │
  ├─ POST /downloads/{id}/ack ───────►│ clientDownloadedAt = now()      │
  │                                   │ Supprime MP4 + VTT serveur      │ ✗ supprimé
  │                                   │                                 │
  │  (lecture offline depuis           │                                 │
  │   fichier local + VTT locaux)     │                                 │
```

## Device Profile

Le client envoie son profil device avec la requête de création :

```json
POST /api/downloads
{
  "mediaFileId": 42,
  "quality": "original",
  "deviceProfile": {
    "supportsHdr": false,
    "audioCodecs": ["aac", "mp3", "opus"],
    "maxAudioChannels": 2
  }
}
```

Le profil est construit côté client via `BrowserDeviceProfileService` qui probe les capacités réelles du navigateur/WebView (canPlayType, MediaSource.isTypeSupported, matchMedia HDR, AudioContext channels).

### Décisions basées sur le profil

| Source | Client | Qualité demandée | Action serveur |
|--------|--------|-------------------|----------------|
| SDR, pas de crop | — | original | Remux rapide (video copy + audio → AAC) |
| SDR, avec crop | — | original | **Transcode complet** avec crop |
| HDR | SDR-only | original | **Transcode complet** avec tonemap HDR→SDR |
| HDR + crop | SDR-only | original | **Transcode complet** avec tonemap + crop |
| HDR | HDR, pas de crop | original | Remux (video copy + audio → AAC) |
| HDR + crop | HDR | original | **Transcode complet** avec crop |
| — | — | 720p/480p/etc. | Transcode complet (tonemap si HDR, crop si détecté) |

### Audio

L'audio est **toujours transcodé en AAC stéréo 192kbps** pour les downloads, quel que soit le format source (DTS, TrueHD, EAC3, FLAC...). Garantit la compatibilité universelle sur tous les devices.

### Tone mapping HDR → SDR

Utilise les mêmes pipelines que le streaming HLS (cf. `docs/transcoding-pipelines.md`) :
- QSV/VAAPI : tonemap via OpenCL (reinhard)
- NVENC : tonemap via CPU (mobius)
- CPU : tonemap via zscale (mobius)

### Crop (suppression bandes noires)

Si le fichier source a des bandes noires détectées (`streamInfo.video[0].crop`), le crop est appliqué automatiquement — même pour la qualité "original". Le crop force un transcode complet (pas de remux possible avec `-c:v copy`).

Pipelines avec crop (cf. `docs/crop-black-bars.md`) :
- QSV/VAAPI → descend à VAAPI : `hwdownload → crop (CPU) → hwupload → scale_vaapi → h264_vaapi`
- NVENC → `hwdownload → crop → scale`
- CPU → `crop → scale → libx264`

Le crop est combinable avec le tonemap HDR→SDR.

## Statuts d'un DownloadTask

| Statut | Signification | Fichier serveur | Action client |
|--------|--------------|----------------|---------------|
| `pending` | En attente de traitement | — | Attendre |
| `transcoding` | FFmpeg transcode en cours | En écriture | Afficher progress via SSE |
| `remuxing` | Remux en cours (video copy) | En écriture | Afficher progress via SSE |
| `ready` | Fichier prêt à être téléchargé | MP4 + VTT présents | Télécharger vers device |
| `downloading` | (frontend only) Téléchargement vers device | Présent | Afficher progress |
| `failed` | Erreur de traitement | — | Afficher erreur |
| `expired` | Fichier nettoyé (jamais téléchargé) | Supprimé | Re-créer le download |

## Sous-titres

### Extraction

Après chaque transcode/remux réussi, le serveur :
1. Identifie les pistes sous-titres **texte** (SRT, ASS, SSA) — ignore les **image** (PGS, VOBSUB)
2. Extrait chaque piste comme fichier `.vtt` séparé via `ffmpeg -c:s webvtt`
3. Stocke les métadonnées dans `DownloadTask.subtitles` : `[{ language, forced, filename }]`
4. Les sous-titres sont aussi embeddés en `mov_text` dans le MP4 (double stockage pour compatibilité)

### Côté client

1. Après téléchargement du MP4, le client télécharge aussi chaque fichier VTT
2. Stockés localement avec la clé `download-{mediaFileId}-sub-{filename}`
3. Le player offline charge les VTT via Shaka `addTextTrackAsync()` avec blob URLs

### Pourquoi VTT séparés + mov_text ?

- `mov_text` embedded : fonctionne sur certains players natifs
- VTT séparés : fonctionne partout via `addTextTrackAsync()` (Android WebView, navigateurs)
- Le player utilise les VTT car plus fiable cross-platform

## Cycle de vie du fichier serveur

1. **Création** : FFmpeg écrit dans `$DOWNLOAD_CACHE_PATH/dl-{taskId}-{quality}.mp4`
2. **Sous-titres** : Extraits en `$DOWNLOAD_CACHE_PATH/dl-{taskId}-sub-{streamIndex}.vtt`
3. **Prêt** : Fichiers restent sur le serveur, en attente du téléchargement client
4. **Téléchargé** : Client fait `POST /downloads/{id}/ack` → fichiers serveur **immédiatement supprimés**
5. **Jamais téléchargé** : Cron `cleanupDownloads` (toutes les 6h) supprime les fichiers `ready` non-ack après 24h

### Pourquoi ACK ?

- Le client confirme "j'ai le fichier" → suppression immédiate côté serveur
- Si le client ne confirme jamais → nettoyage automatique après 24h
- Évite l'accumulation de fichiers transcodés sur le serveur

## Queue GPU prioritaire

- **Priorité haute** : streams live (lecture en cours) — passent immédiatement
- **Priorité basse** : jobs de download — attendent qu'un slot GPU se libère
- Si GPU saturé par downloads et qu'un stream live arrive → le download le plus récent est interrompu

## Stockage client

### Mobile natif (Android/iOS)
- `@capacitor/filesystem` → `Directory.Documents/fliks-downloads/`
- Persiste entre mises à jour de l'app
- Clé MP4 : `download-{mediaFileId}.mp4`
- Clé VTT : `download-{mediaFileId}-sub-{filename}`

### Web (navigateur)
- Cache API → `caches.open('offline-media')`
- Mêmes clés que natif
- Soumis aux quotas navigateur

## Lecture offline

- Le player détecte un fichier local via `OfflineStorageService.getLocalUrl()`
- Si trouvé : `isOfflinePlayback = true`
- **Zéro appel API** : pas de `getOne`, `getPlaybackInfo`, `getPlaybackState`, `loadSubtitles`
- Vidéo chargée via Shaka : `player.load(localUrl, undefined, 'video/mp4')`
- Sous-titres chargés depuis VTT locaux via `player.addTextTrackAsync(blobUrl)`
- Position sauvée en localStorage via `OfflinePlaybackSyncService`, sync au retour online

## SSE Events

```typescript
{ type: 'download.progress', downloadId: number, progress: number }  // 0-100
{ type: 'download.ready', downloadId: number }
{ type: 'download.failed', downloadId: number, error: string }
```

Le frontend écoute ces events via `SseService.lastEvent()` dans un `effect()` Angular.
- `download.progress` → met à jour la progress bar en temps réel
- `download.ready` → lance automatiquement le téléchargement vers le device
- `download.failed` → affiche l'erreur

## Endpoints API

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/api/downloads` | Créer un download (body: `{ mediaFileId, quality, deviceProfile }`) |
| `GET` | `/api/downloads` | Liste des downloads de l'utilisateur |
| `GET` | `/api/downloads/:id` | Statut d'un download |
| `GET` | `/api/downloads/:id/file` | Télécharger le fichier MP4 (Range support) |
| `GET` | `/api/downloads/:id/subtitle/:filename` | Télécharger un fichier VTT |
| `GET` | `/api/downloads/qualities/:fileId` | Qualités disponibles pour un fichier |
| `POST` | `/api/downloads/:id/ack` | Client confirme avoir téléchargé → cleanup serveur |
| `DELETE` | `/api/downloads/:id` | Supprimer un download + fichier local |

## Configuration

| Variable d'environnement | Défaut | Description |
|--------------------------|--------|-------------|
| `DOWNLOAD_CACHE_PATH` | `/tmp/fliks-downloads` | Répertoire des fichiers transcodés + VTT |
