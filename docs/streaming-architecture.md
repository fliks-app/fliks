# Streaming Architecture

## Vue d'ensemble

Le streaming dans Suitarr repose sur un transcodage HLS a la demande avec un seul process FFmpeg par utilisateur par fichier. Le backend decide du mode de lecture (DirectPlay, Remux, Transcode) en fonction du profil appareil du client et des caracteristiques du fichier.

```
Client (Shaka / ExoPlayer / Cast)
  │
  ├─ POST /stream/{id}/playback-info   → Decision: DirectPlay / Remux / Transcode
  ├─ GET  /stream/{id}/master.m3u8     → Master playlist (toutes les variantes)
  ├─ GET  /stream/{id}/{quality}/index.m3u8  → Variant playlist (segments)
  ├─ GET  /stream/{id}/{quality}/init.mp4    → fMP4 init segment
  ├─ GET  /stream/{id}/{quality}/seg-XXXX.m4s → fMP4 media segment
  └─ GET  /stream/{id}                 → DirectPlay (Range requests)
```

## Modes de lecture

### 1. DirectPlay
Le fichier source est servi directement au client avec support Range requests. Aucun transcodage.
- **Condition** : conteneur + codecs video/audio supportes par le client
- **URL** : `/api/stream/{mediaFileId}`

### 2. DirectStream (Remux)
La video est copiee sans re-encodage, l'audio peut etre transcode (ex: DTS → AAC). Le conteneur est remuxe en HLS.
- **Condition** : codec video supporte, mais conteneur ou audio incompatible
- **URL** : `/api/stream/{mediaFileId}/master.m3u8?remux=1`

### 3. Transcode
Video et audio re-encodes en H.264 + AAC dans des segments HLS.
- **Condition** : codec video incompatible, HDR→SDR requis, crop, burn-in sous-titres
- **URL** : `/api/stream/{mediaFileId}/master.m3u8`

## Decision de lecture (StreamBuilderService)

```
1. Essayer DirectPlay
   ├─ Container supporte ? (MP4, WebM...)
   ├─ Codec video supporte ? (H.264, HEVC, AV1...)
   ├─ Codec audio supporte ? (AAC, AC3, EAC3...)
   ├─ Pas de HDR sur client SDR ?
   ├─ Pas de burn-in sous-titres ?
   └─ Pas de crop ?
   → OK: DirectPlay

2. Essayer Remux
   ├─ Codec video supporte (copy possible) ?
   ├─ Pas de tonemap / burn-in / crop ?
   └─ Conteneur ou audio incompatible ?
   → OK: DirectStream (remux HLS, copy video, transcode audio si besoin)

3. Transcode complet
   → H.264 + AAC en HLS
   → Choix du pipeline HW : QSV > VAAPI > NVENC > CPU
```

Voir [transcoding-pipelines.md](transcoding-pipelines.md) pour les pipelines FFmpeg.

## Sessions de transcodage

### Cle de session
- Une session par utilisateur par fichier : `{mediaFileId}-u{userId}`
- Sessions audio separees : `{mediaFileId}-u{userId}-a{audioIndex}`

### Cycle de vie
1. **Creation** : premier segment demande par le client → FFmpeg spawn
2. **Reutilisation** : meme qualite demandee → session existante reutilisee
3. **Changement de qualite** : qualite differente → kill + nouvelle session
4. **Seek** : segment loin du dernier produit → kill + restart avec `-ss`
5. **Expiration** : 60s sans acces → nettoyee
6. **Max concurrent** : 4 sessions par serveur

### Parametres FFmpeg communs
```
-f hls -hls_time 6 -hls_list_size 0 -hls_flags independent_segments
```
- Segments de 6 secondes
- Playlist VOD complete (pas de fenetre glissante)
- Segments independants (chaque segment decodable seul)

### Format de segment

| Format | Extension | Init | Utilisation |
|--------|-----------|------|-------------|
| fMP4 | `.m4s` | `init.mp4` | Shaka (web), ExoPlayer, AVPlayer |
| MPEG-TS | `.ts` | Aucun | Chromecast (Default Receiver) |

Le choix est fait par `supportsHlsFmp4` dans le profil appareil.

## Multi-audio (var_stream_map)

Pour les fichiers avec plusieurs pistes audio, un seul process FFmpeg produit video + toutes les pistes audio en parallele via `-var_stream_map`. Cela garantit la synchronisation parfaite.

### Structure de sortie
```
session/
├─ 0/                    # Video
│  ├─ init_0.mp4
│  ├─ seg-0000.m4s
│  └─ seg-0001.m4s
├─ 1/                    # Audio 0 (ex: English)
│  ├─ init_1.mp4
│  ├─ seg-0000.m4s
│  └─ seg-0001.m4s
└─ 2/                    # Audio 1 (ex: French)
   ├─ init_2.mp4
   ├─ seg-0000.m4s
   └─ seg-0001.m4s
```

### Master playlist avec EXT-X-MEDIA
```
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",URI="audio/0/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",LANGUAGE="fre",URI="audio/1/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8192000,RESOLUTION=1920x816,AUDIO="audio"
1080p/index.m3u8
```

### Conditions d'utilisation
- `useFmp4 = true` (fMP4 requis pour audio separe)
- `videoOnly = true` (segments video sans audio)
- `audioStreams.length > 1` (multi-audio)
- **Jamais utilise pour Cast** (MPEG-TS avec audio muxe)

## ABR (Adaptive Bitrate)

### Shaka (web)
- Master playlist complet avec toutes les variantes
- ABR desactive au demarrage, variante lockee sur la qualite sauvee
- ABR active quand l'utilisateur selectionne "Auto"
- Configuration : `switchInterval: 5s`, `bandwidthUpgradeTarget: 0.7`, `bandwidthDowngradeTarget: 0.95`
- Changement de qualite manuel : `selectVariantTrack(match, true)` + `stopSessions()`
- Pas de reload du player : Shaka lazy-load la nouvelle variante

### ExoPlayer (Android)
- ABR interne d'ExoPlayer
- Controle via `setMaxResolution(width, height)` pour limiter la qualite
- Qualite "Auto" : pas de contrainte, ExoPlayer decide
- Changement manuel : `stopSessions()` + `setMaxResolution()` + `setTrackSelectionParameters()`

### Cast
- Pas d'ABR : qualite fixee par les settings Cast
- Changement = reload complet du stream (`reloadCastStream`)

## Profils de qualite

| Profil | Max Width | Video Bitrate | Audio Bitrate | Bandwidth HLS |
|--------|-----------|---------------|---------------|---------------|
| 2160p | 3840 | 20M | 192k | ~20.2M |
| 1080p | 1920 | 8M | 192k | ~8.2M |
| 720p | 1280 | 4M | 128k | ~4.1M |
| 480p | 854 | 2M | 96k | ~2.1M |
| 360p | 640 | 1M | 64k | ~1.06M |
| 240p | 426 | 500k | 64k | ~564k |
| 144p | 256 | 200k | 48k | ~248k |

**Note crop** : la hauteur reelle peut differer du profil a cause du crop (suppression des bandes noires) et de l'alignement 16px des encodeurs hardware. Ex: 480p avec crop 1920:816 → hauteur reelle 352px.

## Seek

FFmpeg est relance avec :
```
ffmpeg -ss {seconds} -copyts -avoid_negative_ts make_zero -i input.mkv ...
       -hls_list_size 0 -start_number {segment_number} ...
```

- `-ss` avant `-i` : seek rapide (input seek, va au keyframe le plus proche)
- `-copyts` : preserve les timestamps originaux (indispensable pour la sync sous-titres)
- `-avoid_negative_ts make_zero` : corrige les timestamps negatifs
- `-start_number` : les segments continuent la numerotation

## Endpoints de reference

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/stream/info/hw-accel` | GET | Type d'acceleration hardware detecte |
| `/stream/{id}/playback-info` | POST | Decision de lecture (body: DeviceProfile) |
| `/stream/{id}/master.m3u8` | GET | Master playlist HLS |
| `/stream/{id}/{quality}/index.m3u8` | GET | Variant playlist |
| `/stream/{id}/{quality}/{segment}` | GET | Segment video (.m4s/.ts/init.mp4) |
| `/stream/{id}/audio/{idx}/index.m3u8` | GET | Audio rendition playlist |
| `/stream/{id}/audio/{idx}/{segment}` | GET | Audio segment |
| `/stream/{id}/subtitles/{subId}` | GET | Sous-titre externe (VTT) |
| `/stream/{id}/subtitles/embedded/{idx}` | GET | Sous-titre embarque (VTT) |
| `/stream/{id}/thumbnails/sprite.json` | GET | Metadata miniatures seek |
| `/stream/{id}/thumbnails/sprite.jpg` | GET | Sprite sheet miniatures |
| `/stream/{id}/sessions` | DELETE | Arreter la session de transcodage |
| `/stream/{id}` | GET | DirectPlay (Range) |

## Fichiers cles

| Fichier | Role |
|---------|------|
| `backend/src/modules/streaming/streaming.controller.ts` | Tous les endpoints HLS/streaming |
| `backend/src/modules/streaming/transcoding.service.ts` | Sessions FFmpeg, generation playlists, profils |
| `backend/src/modules/streaming/stream-builder.service.ts` | Decision DirectPlay/Remux/Transcode |
| `backend/src/modules/streaming/active-stream-tracker.service.ts` | Cache des decisions de transcodage |
| `backend/src/modules/streaming/subtitle-stream.service.ts` | Extraction sous-titres |
| `backend/src/modules/streaming/subtitle-burn-in.service.ts` | Burn-in sous-titres bitmap |
| `backend/src/modules/streaming/thumbnail.service.ts` | Generation sprite sheets |
