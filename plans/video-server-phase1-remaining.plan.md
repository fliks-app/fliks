# Points restants

## Settings page streaming (Phase 2)
- Section dans Settings pour configurer :
  - Accélération hardware (auto / vaapi / nvenc / qsv / none)
  - Qualité par défaut
  - Nombre max de sessions concurrentes
  - Chemin cache transcodage

## iOS HDR detection (Phase 3)
- Plugin Capacitor Swift pour détecter le support HDR sur iOS
- Utiliser `UIScreen.main.currentEDRHeadroom > 1.0` ou `AVPlayer` capabilities
- Intégrer dans `BrowserDeviceProfileService` (même pattern que `HdrPlugin.java` Android)

## Cast remote mobile (Phase 4)
- Responsive : layout du CastRemoteComponent à adapter pour petit écran (dropdowns trop larges, boutons trop serrés)
- Revoir l'ordre des boutons en bas (sous-titres, audio, qualité) — aligner avec le design du player local
- Tester sur Android avec différentes tailles d'écran
