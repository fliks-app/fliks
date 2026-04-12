# Player Shaka (Web/Desktop)

Moteur de lecture web utilisant [Shaka Player](https://github.com/shaka-project/shaka-player) pour le HLS/DASH via MediaSource Extensions (MSE).

## Fichiers

| Fichier | Role |
|---------|------|
| `frontend/src/app/core/services/playback-engine/shaka-engine.ts` | Wrapper Shaka → interface PlaybackEngine |
| `frontend/src/app/core/services/quality-manager.service.ts` | ABR config, selection de qualite |
| `frontend/src/app/core/services/browser-device-profile.service.ts` | Profil appareil (codecs, HDR, audio) |
| `frontend/src/app/features/player/player.ts` | Composant player principal |

## Initialisation

```typescript
shaka.polyfill.installAll();
const player = new shaka.Player();
await player.attach(videoElement);
player.configure({
  streaming: { bufferingGoal: 60, rebufferingGoal: 5, bufferBehind: 60 },
});
```

Le profil appareil est pre-cache au demarrage de l'app (`app.ts`) pour que les tests `canPlayType()` / `isTypeSupported()` soient deja faits quand le player en a besoin.

## Demarrage de lecture

1. `playbackInfo` POST → backend decide DirectPlay/Remux/Transcode
2. ABR desactive : `player.configure({ abr: { enabled: false } })`
3. `player.load(masterPlaylistUrl)` — Shaka 5.x lazy-load les variantes (seule la variante selectionnee est fetchee)
4. `selectVariantTrack(match)` pour confirmer la qualite
5. Si mode Auto : ABR active apres l'event `playing`

## Lazy loading des variantes (Shaka 5.x)

Shaka ne fetch PAS les `init.mp4` de toutes les variantes au demarrage. Il lazy-load uniquement la variante selectionnee :
- `createSegmentIndex()` n'est appele que pour la variante active
- Les autres variantes ne sont chargees que quand `selectVariantTrack()` les selectionne
- C'est critique pour eviter le thrashing FFmpeg (chaque init.mp4 d'une qualite differente tuerait la session)

## Configuration ABR

Quand l'utilisateur active "Auto" :

```typescript
engine.configure({
  abr: {
    enabled: true,
    defaultBandwidthEstimate: 4_500_000,  // ~720p start
    useNetworkInformation: true,
    switchInterval: 5,                     // Re-evaluate toutes les 5s
    bandwidthUpgradeTarget: 0.7,           // Upgrade a 70% de headroom
    bandwidthDowngradeTarget: 0.95,        // Downgrade quand 95% sature
  },
  streaming: { bufferBehind: 5 },          // Trim buffer pour switch rapide
});
```

## Changement de qualite (sans reload)

### Fixe → autre fixe (ex: 720p → 480p)
1. `abr: { enabled: false }`
2. `streamingApi.stopSessions(mediaFileId)` — kill FFmpeg
3. `engine.selectVariantTrack(match, true)` — Shaka lazy-load la nouvelle variante
4. Backend cree un nouveau FFmpeg a la qualite demandee

### Fixe → Auto
1. `abr: { enabled: true, switchInterval: 5, ... }` — active ABR
2. Shaka decide quand changer

### Auto → fixe
1. `abr: { enabled: false }`
2. `stopSessions()` si la qualite change
3. `selectVariantTrack(match, true)`

**Important** : jamais de `engine.unload()` + `engine.load()` pour changer de qualite. Toujours `selectVariantTrack()`.

## Selection de variante par nom de profil

Les heights reelles des variantes HLS different des profils a cause du crop et de l'alignement 16px. La selection se fait par URL :

```typescript
// Cherche "/480p/" dans l'URL de la variante
findVariantByProfileName(tracks, '480p')
// → trouve la variante dont originalVideoId contient "/480p/"
```

Fallback : `findBestVariantForHeight(tracks, 480)` — la plus grande height <= 480.

## Events bridges

| Event Video HTML5 | Event Engine | Usage |
|-------------------|-------------|-------|
| `timeupdate` | `timeUpdate` | Position, duration, buffered |
| `progress` | `timeUpdate` | Buffer progress (quand le browser telecharge) |
| `waiting` | `stateChanged: buffering` | Spinner de chargement |
| `stalled` | `stateChanged: buffering` | Stall reseau (si buffer < 1s) |
| `playing` | `stateChanged: playing` | Lecture en cours |
| `pause` | `stateChanged: paused` | Pause |
| `canplay` | `stateChanged: playing` | Assez de buffer pour reprendre |
| `ended` | `stateChanged: ended` | Fin de lecture |
| `error` | `error` + `stateChanged: error` | Erreur de lecture |

## Statistiques (nerds)

Le player expose `engine.getStats()` :
- `activeVariant` : width, height, videoBandwidth, videoCodec
- `droppedFrames`, `streamBandwidth`

La resolution affichee dans les stats utilise le nom du profil extrait de l'URL (`/720p/` → "720p") au lieu de la resolution brute (evite "640x272" pour 360p croppe).

## Sous-titres

- **Sidecar** : `player.addTextTrackAsync(url, language, 'subtitles', 'text/vtt')`
- **Burn-in** (PGS/VOBSUB) : gere cote backend via filtre FFmpeg, pas par Shaka
- Selection : `player.selectTextTrack(track)` + `player.setTextTrackVisibility(true/false)`

## Limites connues

- Le Default Media Receiver Chromecast ne supporte pas fMP4 HLS → MPEG-TS force pour Cast
- `selectVariantTrack(track, true)` avec `clearBuffer` peut relancer la lecture si le player etait en pause (corrige par `if (wasPaused) engine.pause()`)
- Les restrictions Shaka par height (`minHeight/maxHeight`) causent des erreurs 4032 quand le crop change les dimensions → utiliser le match par URL
