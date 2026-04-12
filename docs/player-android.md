# Player Android (ExoPlayer / Media3)

Moteur de lecture natif utilisant AndroidX Media3 ExoPlayer derriere une WebView transparente.

## Fichiers

| Fichier | Role |
|---------|------|
| `frontend/android/app/src/main/java/com/fliks/app/NativePlayerPlugin.java` | Plugin Capacitor : ExoPlayer lifecycle, tracks, subtitles, quality |
| `frontend/src/app/core/services/playback-engine/native-engine.ts` | Wrapper TypeScript → interface PlaybackEngine |
| `frontend/src/app/core/plugins/native-player.plugin.ts` | Interface TypeScript du plugin Capacitor |
| `frontend/android/app/build.gradle` | Dependances Media3 |

## Architecture

```
┌─────────────────────────────────────┐
│         WebView (Angular UI)        │  ← Controles, overlay, transparent
├─────────────────────────────────────┤
│         SubtitleView (z=1)          │  ← Sous-titres natifs
├─────────────────────────────────────┤
│  TextureView (ExoPlayer surface)    │  ← Video rendue en dessous
└─────────────────────────────────────┘
```

- `TextureView` rendu derriere la WebView transparente
- `SubtitleView` entre la video et la WebView (z-index 1)
- `AspectRatioFrameLayout` pour le ratio d'aspect correct
- `FLAG_KEEP_SCREEN_ON` active pendant la lecture

## Initialisation (NativePlayerPlugin.java)

```java
// DataSource pour HTTP + file://
DefaultDataSource.Factory dataSourceFactory = new DefaultDataSource.Factory(ctx, httpFactory);
DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(dataSourceFactory);

player = new ExoPlayer.Builder(getContext())
    .setMediaSourceFactory(mediaSourceFactory)
    .setWakeMode(C.WAKE_MODE_NETWORK)
    .build();
player.setVideoTextureView(textureView);
```

## Chargement

```java
// Build MediaItem avec sous-titres preloades
MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(hlsUrl);
if (!subtitleConfigs.isEmpty()) {
    itemBuilder.setSubtitleConfigurations(subtitleConfigs);
}
player.setMediaItem(itemBuilder.build());

// Desactiver les sous-titres par defaut
player.setTrackSelectionParameters(
    player.getTrackSelectionParameters().buildUpon()
        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        .build());

player.prepare();
if (startTime > 0) player.seekTo((long)(startTime * 1000));
player.setPlayWhenReady(true);
```

## Controle de qualite

ExoPlayer gere l'ABR en interne. On controle via la resolution maximale :

```java
// Limiter a 720p
player.setTrackSelectionParameters(
    player.getTrackSelectionParameters().buildUpon()
        .setMaxVideoSize(1280, 720)
        .build());

// Mode auto (pas de contrainte)
player.setTrackSelectionParameters(
    player.getTrackSelectionParameters().buildUpon()
        .setMaxVideoSize(Integer.MAX_VALUE, Integer.MAX_VALUE)
        .build());
```

**Important** : les widths doivent correspondre exactement aux profils backend pour eviter les erreurs off-by-one :

| Profil | Width exacte |
|--------|-------------|
| 2160p | 3840 |
| 1080p | 1920 |
| 720p | 1280 |
| 480p | 854 |
| 360p | 640 |
| 240p | 426 |
| 144p | 256 |

Au demarrage sur Android, la qualite sauvee est appliquee AVANT `engine.load()` via `setMaxResolution()` pour eviter que ExoPlayer demarre en 4K (transcodage lent → desync A/V).

## Pistes audio

Selection par flat index (pas par group) :

```java
int flatIdx = 0;
for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
    if (group.getType() == C.TRACK_TYPE_AUDIO) {
        for (int i = 0; i < group.length; i++) {
            if (flatIdx == targetFlatIdx) {
                player.setTrackSelectionParameters(
                    player.getTrackSelectionParameters().buildUpon()
                        .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), i))
                        .build());
                return;
            }
            flatIdx++;
        }
    }
}
```

## Sous-titres

### Preload au chargement
Les sous-titres sont inclus dans le `MediaItem` via `SubtitleConfiguration` :

```java
new MediaItem.SubtitleConfiguration.Builder(Uri.parse(subtitleUrl))
    .setMimeType(MimeTypes.TEXT_VTT)
    .setLanguage("fre")
    .setLabel("French")
    .build()
```

### Selection
```java
// Activer
player.setTrackSelectionParameters(
    builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
           .setOverrideForType(new TrackSelectionOverride(group.getMediaTrackGroup(), 0))
           .build());

// Desactiver
player.setTrackSelectionParameters(
    builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build());
```

### Style
```java
CaptionStyleCompat style = new CaptionStyleCompat(
    foregroundColor, backgroundColor, Color.TRANSPARENT,
    edgeType, Color.BLACK, Typeface.DEFAULT);
subtitleView.setStyle(style);
subtitleView.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp);
```

## Events vers le frontend

Communication via `evaluateJavascript` → `CustomEvent` sur la WebView :

```java
private void emitStateChanged(String state) {
    getBridge().getWebView().evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('nativePlayerStateChanged'," +
        "{detail:{state:'" + state + "'}}));", null);
}
```

### Events emis

| Event Java | Event Frontend | Declencheur |
|------------|----------------|-------------|
| `onPlaybackStateChanged(STATE_BUFFERING)` | `stateChanged: buffering` | En attente de segments |
| `onPlaybackStateChanged(STATE_READY)` | `stateChanged: playing/paused` | Pret a jouer |
| `onPlaybackStateChanged(STATE_ENDED)` | `stateChanged: ended` | Fin de lecture |
| `onIsPlayingChanged(true)` | `stateChanged: playing` | Lecture en cours |
| `onIsPlayingChanged(false)` | `stateChanged: paused/buffering` | Pause ou buffering |
| `onVideoSizeChanged` | `nativePlayerVideoSize` | Changement de resolution |
| `onTracksChanged` | `nativePlayerTracksChanged` | Pistes audio/video changees |
| `onPlayerError` | `nativePlayerError` | Erreur de lecture |

### Position polling
Le NativeEngine TypeScript poll `NativePlayer.getPosition()` toutes les secondes :

```typescript
setInterval(async () => {
  const pos = await NativePlayer.getPosition();
  this.emit('timeUpdate', { position, duration, buffered });
}, 1000);
```

## Luminosite HDR

Pour le contenu HDR sur Android :
```java
WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
lp.screenBrightness = 1.0f;  // Max brightness
getActivity().getWindow().setAttributes(lp);
// Dim subtitle view
subtitleView.setAlpha(0.5f);
```

## Limites connues

- Le volume est gere par le systeme Android, pas par ExoPlayer
- Les sous-titres PGS/VOBSUB ne sont pas supportes en sidecar — burn-in cote backend
- Le `pendingSubtitleTrackId` gere la selection differee quand les tracks ne sont pas encore prets
- `-copyts` dans FFmpeg est necessaire pour la sync des sous-titres embedded apres un seek
