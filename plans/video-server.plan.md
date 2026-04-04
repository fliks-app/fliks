# Plan : Serveur vidéo intégré à Suitarr

## État d'avancement (mis à jour 2026-04-04)

### Phase 1 : Direct Play + Player UI — ✅ TERMINÉE
- ✅ Streaming direct (Range requests, MP4/MKV)
- ✅ Endpoints sous-titres (externes + embarqués, conversion SRT/ASS → VTT)
- ✅ Playback state (resume, continue watching, historique)
- ✅ Player Shaka complet : controls custom, seek, volume, PiP, plein écran
- ✅ Stats overlay (codec, bitrate, résolution, mode, HW accel)
- ✅ Raccourcis clavier complets
- ✅ Mobile Capacitor (Android) : immersive, PiP natif, orientation landscape
- ✅ Dashboard "Continuer à regarder"

### Phase 2 : Transcodage à la volée — ✅ TERMINÉE
- ✅ HLS multi-qualité (master playlist, segments TS)
- ✅ Détection hardware auto (QSV > VAAPI > NVENC > CPU)
- ✅ Profils de qualité adaptatifs (1080p, 720p, 480p)
- ✅ Remux mode (copy video, transcode audio si nécessaire)
- ✅ Session management (timeout 60s, max 3 sessions, eviction LRU)
- ✅ Seek : redémarrage FFmpeg à la position demandée
- ✅ Graceful kill (attend la fin du process avant cleanup)
- ✅ Device profile detection (frontend détecte codecs supportés)
- ✅ ABR avec Shaka Player + sélecteur de qualité UI
- ✅ Buffer 60s en avance
- ✅ Barre de progression custom avec zone bufferisée
- ✅ Mémorisation langue sous-titres (localStorage)
- ⬜ Settings page streaming (HW accel, qualité par défaut, max sessions)

### Phase 2.5 : Dashboard flux actifs — 🆕 À FAIRE
- ⬜ Endpoint admin : sessions de transcodage en cours + qui regarde quoi
- ⬜ Page admin : tableau temps réel des flux actifs (user, média, qualité, durée, HW accel)
- ⬜ Actions admin : kill session, voir stats

### Phase 3 : HDR Tone Mapping — ⬜ À FAIRE
### Phase 4 : Chromecast + DLNA — ⬜ À FAIRE
### Phase 5 : Sous-titres avancés (burn-in) — ⬜ À FAIRE
### Phase 6 : Watch Together + Profils — ⬜ À FAIRE

---

## Contexte
Suitarr gère déjà l'acquisition et l'organisation des médias. L'objectif est d'intégrer un serveur vidéo complet (comparable à Jellyfin) pour éliminer la dépendance à un serveur externe. Le serveur doit supporter le direct play, le transcodage hardware (VA-API, NVENC, QSV), le HDR tone mapping, Chromecast, et les apps natives iOS/Android via Capacitor.

## Infrastructure existante réutilisable
- **FFmpeg** : déjà dans le container Docker, `FfprobeService` analyse les streams
- **Auth JWT** : supporte cookie, Bearer header, et query param `?token=` (idéal pour les URL HLS)
- **streamInfo** : métadonnées video/audio déjà stockées en JSONB sur `MediaFile`
- **SSE events** : système extensible pour sync état de lecture
- **Capacitor** : `ServerConfigService.isNative` détecte iOS/Android
- **User entity** : existe avec rôles et permissions

---

## Phase 1 : Direct Play + Player UI

**Objectif** : Lire un fichier vidéo sans transcodage. Le navigateur/app lit le fichier directement si le codec est compatible.

### Backend

#### 1.1 Endpoint de streaming direct
**Nouveau fichier** : `backend/src/modules/streaming/streaming.controller.ts`
```
GET /api/stream/:mediaFileId
```
- Auth via JWT (cookie, header, ou `?token=`)
- Résout le chemin absolu via `media.path + file.relativePath`
- Supporte HTTP Range requests (seek dans la vidéo)
- Headers : `Content-Type` (video/mp4, video/x-matroska), `Accept-Ranges: bytes`, `Content-Range`
- Pour les MKV : remux à la volée en MP4 via FFmpeg pipe (les navigateurs ne supportent pas MKV nativement)

#### 1.2 Endpoint sous-titres
```
GET /api/stream/:mediaFileId/subtitles/:subtitleId
```
- Sert les fichiers .srt/.ass depuis le disque
- Convertit ASS → VTT à la volée (shaka-player utilise WebVTT)

#### 1.3 Endpoint sous-titres embarqués
```
GET /api/stream/:mediaFileId/subtitles/embedded/:streamIndex
```
- Extrait un flux sous-titre embarqué via `ffmpeg -map 0:s:N -f webvtt pipe:1`

#### 1.4 Playback state (resume/historique)
**Nouvelle entity** : `backend/src/modules/streaming/entities/playback-state.entity.ts`
```typescript
@Entity('playback_states')
@Unique(['userId', 'mediaFileId'])
export class PlaybackState extends BaseEntity {
  @Column() userId: number;
  @Column() mediaFileId: number;
  @Column({ nullable: true }) episodeId: number;
  @Column({ type: 'float', default: 0 }) positionSeconds: number;
  @Column({ type: 'float', default: 0 }) durationSeconds: number;
  @Column({ default: false }) completed: boolean;
  @Column({ type: 'timestamptz' }) lastPlayedAt: Date;
}
```

**Endpoints** :
```
GET    /api/playback/:mediaFileId        → état actuel
PUT    /api/playback/:mediaFileId        → { positionSeconds, durationSeconds }
GET    /api/playback/continue-watching   → liste des médias en cours
GET    /api/playback/history             → historique complet
DELETE /api/playback/:mediaFileId        → supprimer l'état
```

#### 1.5 Module streaming
**Nouveau module** : `backend/src/modules/streaming/`
```
streaming.module.ts
streaming.controller.ts
streaming.service.ts          ← logique de résolution de fichier + range requests
subtitle-stream.service.ts    ← extraction/conversion sous-titres
playback.controller.ts
playback.service.ts
entities/playback-state.entity.ts
```

### Frontend

#### 1.6 Page Player
**Nouveaux fichiers** : `frontend/src/app/features/player/`
```
player.ts                     ← composant principal
player.html
player-controls.ts            ← barre de contrôle custom
player-controls.html
player-subtitle-picker.ts     ← sélection piste sous-titre
player-audio-picker.ts        ← sélection piste audio
```

**Route** : `/watch/:mediaFileId` (avec query params optionnels `?episodeId=&t=` pour resume)

**Lecteur vidéo** : `shaka-player` (supporte HLS, DASH, MP4 direct, WebVTT, multi-audio)
- `npm install shaka-player` dans le frontend
- Direct play : `<video>` natif avec source MP4/remux
- Sous-titres : chargement des tracks WebVTT via l'API shaka
- Sélection audio/sous-titres : UI custom avec les données de `streamInfo`
- Resume : charge `positionSeconds` au démarrage, envoie `PUT /api/playback` toutes les 10s
- Bouton plein écran, PiP (Picture-in-Picture)

**UI custom shaka-player** : Le player par défaut de shaka sera entièrement re-skinné :
- Barre de contrôle custom DaisyUI (pas l'UI shaka par défaut) — utilise l'API `shaka.Player` sans le plugin UI
- Thème cohérent avec le reste de Suitarr (couleurs, typographie, animations)
- Boutons additionnels : épisode suivant/précédent (séries), vitesse de lecture, ratio d'aspect
- Miniatures de preview au survol de la timeline (via sprite sheet ou BIF)
- Gestion des raccourcis clavier (espace, flèches, F, M, etc.)
- Skip intro / Skip outro (si les timestamps sont disponibles)

**Statistiques de lecture (overlay "Stats for Nerds")** :
- Panneau toggle via bouton ou raccourci clavier (ex: `Shift+S`)
- Informations affichées en temps réel :
  - **Vidéo** : codec, résolution, bitrate, framerate, profil, HDR format
  - **Audio** : codec, canaux, langue, bitrate, sample rate
  - **Lecture** : mode (direct play / remux / transcode), buffer health, dropped frames
  - **Réseau** : bande passante estimée, latence, segments téléchargés
  - **Transcodage** (si actif) : vitesse de transcodage, accélération hardware utilisée, qualité cible
  - **Session** : durée de lecture, position, temps restant
- Données récupérées via `shaka.Player.getStats()` + infos du backend (mode, hw accel)
- Style : overlay semi-transparent monospace en bas à gauche (comme Emby/YouTube)

#### 1.7 Intégration dans les pages existantes
- **media-detail.html** : bouton "Lire" sur chaque fichier
- **episode-detail.html** : bouton "Lire" principal
- **Dashboard** : section "Continuer à regarder" (via `/api/playback/continue-watching`)

#### 1.8 Capacitor (iOS/Android)
- Le player utilise `ServerConfigService.resolveUrl()` pour construire les URLs de stream
- Auth via `?token=` dans l'URL du stream (les players natifs ne supportent pas les cookies cross-origin)

### Vérification Phase 1
- Lire un fichier MP4 H264 dans Chrome → direct play
- Lire un fichier MKV → remux MP4 à la volée
- Seek dans la vidéo → Range requests
- Sous-titres externes (.srt) → affichés via WebVTT
- Resume : fermer et rouvrir → reprend à la bonne position
- Mobile : lire via l'app Capacitor

---

## Phase 2 : Transcodage à la volée

**Objectif** : Transcoder le flux vidéo/audio en temps réel quand le client ne supporte pas le codec source. Support hardware (VA-API, NVENC, QSV).

### Backend

#### 2.1 Transcoding service
**Nouveau fichier** : `backend/src/modules/streaming/transcoding.service.ts`

**Détection de compatibilité** :
- Le frontend envoie ses codecs supportés via header `X-Playback-Capabilities` ou query param
- Le backend compare avec `streamInfo` du fichier
- Décision : direct play, remux, ou transcode

**Profils de transcodage** :
```typescript
interface TranscodeProfile {
  videoCodec: 'h264' | 'h265' | 'av1' | 'copy';
  audioCodec: 'aac' | 'opus' | 'copy';
  maxWidth?: number;
  maxBitrate?: number;
  hwAccel?: 'vaapi' | 'nvenc' | 'qsv' | null;
}
```

**Qualités adaptatives** (comme Jellyfin) :
- 4K (2160p) → max 80 Mbps
- 1080p → max 20 Mbps
- 720p → max 8 Mbps
- 480p → max 4 Mbps
- Auto (basé sur bande passante)

#### 2.2 HLS à la volée
```
GET /api/stream/:mediaFileId/master.m3u8     ← playlist multi-qualité
GET /api/stream/:mediaFileId/:quality/index.m3u8  ← playlist segments
GET /api/stream/:mediaFileId/:quality/:segment.ts ← segment vidéo
```

**Implémentation** :
- FFmpeg génère les segments HLS à la demande
- Cache des segments en mémoire/tmpfs (TTL 5min)
- Un process FFmpeg par session de lecture (tué à la déconnexion)
- Seek : redémarre FFmpeg à la position demandée

#### 2.3 Hardware acceleration
**Détection au démarrage** :
```typescript
// streaming.service.ts onModuleInit
async detectHardwareAccel(): Promise<HwAccelCapability> {
  // Test: ffmpeg -hwaccels
  // Test: ffmpeg -init_hw_device vaapi=/dev/dri/renderD128
  // Test: ffmpeg -init_hw_device cuda
  // Test: ffmpeg -init_hw_device qsv
}
```

**FFmpeg command patterns** :
```bash
# VA-API (Intel/AMD)
ffmpeg -hwaccel vaapi -hwaccel_output_format vaapi -hwaccel_device /dev/dri/renderD128 \
  -i input.mkv -c:v h264_vaapi -b:v 8M -c:a aac ...

# NVENC (NVIDIA)
ffmpeg -hwaccel cuda -hwaccel_output_format cuda \
  -i input.mkv -c:v h264_nvenc -b:v 8M -c:a aac ...

# QSV (Intel)
ffmpeg -hwaccel qsv -hwaccel_output_format qsv \
  -i input.mkv -c:v h264_qsv -b:v 8M -c:a aac ...
```

#### 2.4 Session management
**Nouvelle entity** : `streaming/entities/transcode-session.entity.ts`
- Tracker les sessions FFmpeg actives
- Timeout automatique après 30min d'inactivité
- Nettoyage des fichiers temporaires
- Limite de sessions concurrentes (configurable)

#### 2.5 Settings
Nouvelles clés dans `app_settings` :
- `streaming_hw_accel`: 'auto' | 'vaapi' | 'nvenc' | 'qsv' | 'none'
- `streaming_max_sessions`: 3
- `streaming_cache_path`: '/tmp/suitarr-transcode'
- `streaming_default_quality`: 'auto'

#### 2.6 Docker GPU passthrough
```yaml
# docker-compose.yml
backend:
  devices:
    - /dev/dri:/dev/dri          # VA-API / QSV
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia        # NVENC
            count: 1
            capabilities: [gpu]
```

### Frontend

#### 2.7 Adaptive bitrate
- shaka-player gère nativement l'ABR (Adaptive Bitrate) avec HLS
- UI : sélecteur de qualité (Auto, 4K, 1080p, 720p, 480p)
- Affichage du débit actuel et de la qualité

#### 2.8 Settings page streaming
- Section dans Settings pour configurer :
  - Accélération hardware
  - Qualité par défaut
  - Nombre max de sessions
  - Chemin cache

### Vérification Phase 2
- Fichier H265 → transcodé en H264 à la volée
- Sélection qualité 720p → fichier 4K transcodé en 720p
- GPU passthrough → logs FFmpeg montrent `hwaccel`
- 2 utilisateurs simultanés → 2 sessions de transcodage
- Seek en milieu de vidéo → segment généré rapidement

---

## Phase 2.5 : Dashboard flux actifs (admin)

**Objectif** : Permettre aux admins de voir en temps réel qui regarde quoi, avec quel mode de lecture, et pouvoir gérer les sessions.

### Backend

#### 2.5.1 Tracker les sessions de lecture actives
**Enrichir** `TranscodingService` :
- Exposer une méthode `getActiveSessions()` retournant pour chaque session :
  - `sessionId`, `mediaFileId`, `quality`, `startedAt`, `lastAccess`, `hwAccel`
- Associer le `userId` aux sessions (passé lors de la création de session)

**Enrichir** `StreamingService` / nouveau `ActiveStreamService` :
- Tracker aussi les sessions direct play (pas seulement transcode)
- Stocker en mémoire (Map) : `userId`, `mediaFileId`, `mediaTitle`, `episodeLabel`, `mode` (direct/remux/transcode), `quality`, `startedAt`, `positionSeconds`
- Mise à jour via les appels `PUT /api/playback` existants
- Nettoyage automatique des sessions stale (> 2min sans mise à jour)

#### 2.5.2 Endpoints admin
```
GET /api/admin/streams              → liste des flux actifs
GET /api/admin/streams/stats        → statistiques (nb sessions, bande passante totale, usage HW)
DELETE /api/admin/streams/:sessionId → kill une session de transcodage
```

**Réponse `GET /api/admin/streams`** :
```typescript
interface ActiveStream {
  sessionId: string;
  userId: number;
  username: string;
  mediaId: number;
  mediaTitle: string;
  episodeLabel: string | null;   // "S2:E3 - Titre" ou null
  posterUrl: string | null;
  mode: 'direct' | 'remux' | 'transcode';
  quality: string;               // "original", "1080p", "720p"
  hwAccel: string;               // "qsv", "vaapi", "none"
  startedAt: string;             // ISO date
  positionSeconds: number;
  durationSeconds: number;
  transcodeFps: number | null;   // vitesse de transcodage en temps réel
}
```

### Frontend

#### 2.5.3 Page admin "Flux actifs"
**Route** : `/system/streams` ou section dans la page System existante

**UI** :
- Tableau avec colonnes : User (avatar+nom), Média (poster+titre), Mode (badge direct/remux/transcode), Qualité, HW Accel, Durée de session, Progression
- Badge couleur par mode : vert (direct), bleu (remux), orange (transcode)
- Bouton "Kill" par session (avec confirmation)
- Header avec stats résumées : X flux actifs, Y en transcodage, Z utilisant le GPU
- Auto-refresh toutes les 5s (ou SSE pour temps réel)

### Vérification Phase 2.5
- 2 utilisateurs regardent → 2 lignes dans le dashboard
- Kill une session → le player de l'utilisateur reçoit une erreur
- Session stale (onglet fermé) → disparaît après 2min

---

## Phase 3 : HDR Tone Mapping

**Objectif** : Convertir le contenu HDR (HDR10, HDR10+, Dolby Vision) en SDR pour les écrans non-HDR, ou préserver le HDR quand le client le supporte.

### Backend

#### 3.1 Détection HDR
Enrichir `VideoStreamInfo` dans `ffprobe.service.ts` :
```typescript
// Nouveaux champs à extraire via ffprobe
colorSpace?: string;        // bt2020nc, bt709
colorTransfer?: string;     // smpte2084 (PQ/HDR10), arib-std-b67 (HLG)
colorPrimaries?: string;    // bt2020
hdrFormat?: 'HDR10' | 'HDR10+' | 'DolbyVision' | 'HLG' | null;
```

#### 3.2 Tone mapping FFmpeg
```bash
# VA-API tone mapping (Intel)
-vf 'format=p010,hwupload,tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709'

# NVENC tone mapping (NVIDIA)
-vf 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

# Software fallback
-vf 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709,format=yuv420p'
```

#### 3.3 Client capability detection
Le frontend signale au backend :
```typescript
interface ClientCapabilities {
  supportsHdr: boolean;          // via matchMedia('(dynamic-range: high)')
  supportsHevc: boolean;         // via MediaSource.isTypeSupported()
  supportsDolbyVision: boolean;
  maxResolution: { w: number, h: number };
}
```

### Frontend

#### 3.4 HDR badge UI
- Badge "HDR" / "DV" sur les fichiers dans les pages détail
- Indicateur dans le player quand le tone mapping est actif

### Vérification Phase 3
- Fichier HDR10 sur écran SDR → tone mapping automatique
- Fichier HDR10 sur écran HDR → direct play HDR préservé
- Dolby Vision Profile 5 → tone mapping vers SDR
- Qualité visuelle du tone mapping acceptable

---

## Phase 4 : Chromecast + DLNA

**Objectif** : Diffuser le contenu sur Chromecast, Google TV, et appareils DLNA.

### Backend

#### 4.1 Chromecast receiver
**Nouveau fichier** : `frontend/src/app/features/player/cast-receiver.html`
- Page HTML autonome servie par le backend
- Intègre le Cast Application Framework (CAF) Receiver SDK
- Enregistrée comme Custom Web Receiver dans la Google Cast Console

#### 4.2 Cast media server endpoint
```
GET /api/stream/:mediaFileId/cast.m3u8
```
- HLS optimisé pour Chromecast (H264 max, AAC audio)
- Sous-titres en sidecar WebVTT
- Chromecast ne supporte pas HEVC sur la plupart des modèles → force transcode H264

### Frontend

#### 4.3 Cast SDK integration
```bash
npm install chromecast-caf-sender  # ou script Google Cast SDK
```

**Dans le player** :
- Bouton Cast (icône standard Google Cast)
- `cast.framework.CastContext` pour la découverte
- Transfert de session : passage web→cast et cast→web
- Sync de la position de lecture pendant le cast
- Contrôle du volume et transport (play/pause/seek) depuis l'UI web

#### 4.4 App native (Capacitor)
- iOS : `GCKCastContext` via plugin Capacitor custom ou `@nicandor/capacitor-google-cast`
- Android : Cast SDK natif via plugin Capacitor

#### 4.5 DLNA/UPnP (optionnel)
- Backend : serveur DLNA basique avec `node-ssdp` + `upnp-mediaserver`
- Expose la bibliothèque aux TV connectées et lecteurs DLNA
- Plus simple que Chromecast mais couverture plus large

### Vérification Phase 4
- Chrome desktop → icône Cast visible, sélection du Chromecast, lecture
- App iOS → Cast sur Chromecast/Google TV
- Sous-titres affichés sur le Chromecast
- Pause/play/seek depuis le téléphone pendant le cast

---

## Phase 5 : Sous-titres avancés (burn-in)

**Objectif** : Gravage des sous-titres dans la vidéo quand le client ne supporte pas le rendu (Chromecast avec ASS, certains players).

### Backend

#### 5.1 Burn-in FFmpeg
```bash
# SRT/VTT burn-in
-vf "subtitles='/path/to/sub.srt':force_style='FontSize=24'"

# ASS burn-in (conserve le style)
-vf "ass='/path/to/sub.ass'"

# Embedded subtitle burn-in
-vf "subtitles='/path/to/video.mkv':si=0"
```

#### 5.2 Logique de décision
```
Si client supporte WebVTT → sidecar (rendu client)
Si sous-titre SRT/VTT + Chromecast → sidecar
Si sous-titre ASS + Chromecast → burn-in (ASS non supporté par Cast)
Si sous-titre PGS/VOBSUB → toujours burn-in (bitmap, pas de texte)
```

### Frontend
- Indicateur "gravé" dans le sélecteur de sous-titres quand le burn-in est actif
- Option dans les settings : "Préférer le rendu client" vs "Toujours graver"

---

## Phase 6 : Watch Together + Profils

**Objectif** : Profils utilisateur avec préférences de lecture, et lecture synchronisée multi-utilisateurs.

### 6.1 Profils utilisateur
- Préférences : langue audio par défaut, langue sous-titres par défaut, qualité préférée
- Avatar / nom de profil
- Historique et reprise par profil
- Contrôle parental (rating max)

### 6.2 Watch Together
- WebSocket room pour synchroniser play/pause/seek entre utilisateurs
- Un "hôte" contrôle la lecture, les autres suivent
- Chat textuel en temps réel pendant la lecture
- Invitation par lien partageable

---

## Ordre d'implémentation recommandé

```
Phase 1 (Direct Play)          ✅ TERMINÉE
  └─ Player fonctionnel, resume, sous-titres client-side
Phase 2 (Transcodage)          ✅ TERMINÉE (sauf settings page)
  └─ HLS adaptatif, GPU, multi-qualité
Phase 2.5 (Dashboard flux)     ← PROCHAINE ÉTAPE
  └─ Admin : voir qui regarde quoi, kill sessions
Phase 3 (HDR Tone Mapping)
  └─ Détection HDR, conversion SDR automatique
Phase 5 (Burn-in sous-titres)
  └─ ASS/PGS gravés pour Chromecast
Phase 4 (Chromecast)
  └─ Cast SDK, receiver, DLNA
Phase 6 (Watch Together)
  └─ Profils, sync multi-utilisateurs
```

> Note : Phase 5 (burn-in) avant Phase 4 (Chromecast) car le Chromecast nécessite le burn-in pour les sous-titres ASS.

## Fichiers critiques existants à réutiliser
- `backend/src/modules/subtitles/ffprobe.service.ts` — analyse vidéo
- `backend/src/modules/media/entities/media-file.entity.ts` — streamInfo
- `backend/src/modules/auth/strategies/jwt.strategy.ts` — auth query param pour HLS
- `backend/src/modules/scheduler/events.service.ts` — SSE extensible
- `frontend/src/app/core/services/server-config.service.ts` — détection Capacitor
- `frontend/src/app/core/services/auth.service.ts` — token pour URLs stream
