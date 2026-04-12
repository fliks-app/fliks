# Player iOS (AVPlayer)

Moteur de lecture natif iOS utilisant AVPlayer. Prepare mais pas encore integre dans l'app Capacitor.

## Fichiers

| Fichier | Role |
|---------|------|
| `frontend/ios-plugin-ready/NativePlayerPlugin.swift` | Plugin Capacitor : AVPlayer lifecycle (pret, non integre) |
| `frontend/src/app/core/services/playback-engine/native-engine.ts` | Wrapper TypeScript partage avec Android |
| `frontend/src/app/core/plugins/native-player.plugin.ts` | Interface TypeScript du plugin Capacitor |

## Statut

Le plugin iOS est **prepare** (`ios-plugin-ready/`) mais **pas integre** dans le projet Capacitor. Il faudra :
1. `npx cap add ios`
2. Copier `NativePlayerPlugin.swift` dans le projet iOS
3. Enregistrer le plugin dans `AppDelegate.swift`
4. Tester sur device physique (simulateur ne supporte pas le streaming HLS correctement)

## Architecture prevue

Meme approche que Android :
```
┌─────────────────────────────────────┐
│         WKWebView (Angular UI)      │  ← Controles, overlay, transparent
├─────────────────────────────────────┤
│         AVPlayerLayer               │  ← Video rendue en dessous
└─────────────────────────────────────┘
```

- `AVPlayerLayer` derriere la WKWebView transparente
- Sous-titres via `AVPlayerItem.externalMetadata` ou WebVTT sidecar
- Communication WebView ↔ Swift via Capacitor bridge

## HLS natif sur iOS

iOS supporte HLS nativement via AVPlayer — pas besoin de Shaka ou autre librairie.
- fMP4 et MPEG-TS supportes
- ABR interne d'AVPlayer
- Sous-titres WebVTT inline ou sidecar

## Profil appareil iOS

Le profil iOS devrait etre similaire a Android :
```typescript
{
  directPlayProfiles: [
    { containers: ['mp4', 'mov', 'm4v'], videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3', 'alac'] }
  ],
  supportsHlsFmp4: true,
  supportsHlsTs: true,
  supportsHdr: true,  // iPhones 12+ et iPad Pro supportent HDR
  supportsMultiAudioMuxed: false,  // EXT-X-MEDIA pour multi-audio
  maxStreamingBitrate: 40_000_000,
  maxAudioChannels: 8,  // Spatial Audio
}
```

## Interface NativeEngine partagee

Le `NativeEngine` TypeScript est identique pour Android et iOS. Il communique avec le plugin natif via le meme protocole Capacitor :

```typescript
// Memes methodes que Android
NativePlayer.create({ x, y, width, height });
NativePlayer.load({ url, startTime, headers, subtitles });
NativePlayer.play();
NativePlayer.pause();
NativePlayer.seekTo({ position });
NativePlayer.getPosition();  // → { position, duration, buffered }
NativePlayer.selectAudioTrack({ id });
NativePlayer.selectSubtitleTrack({ id });
NativePlayer.setMaxResolution({ width, height });
NativePlayer.destroy();
```

## Differences cles avec Android

| Aspect | Android (ExoPlayer) | iOS (AVPlayer) |
|--------|-------------------|----------------|
| Surface video | TextureView | AVPlayerLayer |
| Sous-titres | SubtitleView + CaptionStyleCompat | AVPlayerItem external metadata |
| ABR control | setMaxResolution / setTrackSelectionParameters | preferredPeakBitRate / preferredMaximumResolution |
| Audio switch | TrackSelectionOverride | AVPlayerItem.select(mediaSelectionOption) |
| HDR | VAAPI/MediaCodec | Metal + EDR |
| PiP | custom PiP plugin | AVPictureInPictureController natif |

## TODO pour l'integration

- [ ] `npx cap add ios`
- [ ] Integrer NativePlayerPlugin.swift
- [ ] Tester HLS fMP4 + multi-audio
- [ ] Tester sous-titres sidecar WebVTT
- [ ] Tester PiP natif
- [ ] Tester AirPlay (similaire a Cast mais cote iOS)
- [ ] HDR support detection via plugin
