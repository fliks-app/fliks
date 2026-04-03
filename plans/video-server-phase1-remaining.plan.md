# Phase 1 — Points restants à finir

## 1. Dashboard "Continuer à regarder"
- Nouvelle section en haut du dashboard
- Cards horizontales scrollables avec poster, titre, barre de progression, bouton play
- Fetch via `StreamingApiService.getContinueWatching()`

## 2. Sauvegarde resume
- Le code existe (timer 10s + `PUT /playback`) mais pas testé en conditions réelles
- Vérifier que le resume fonctionne (fermer le player, rouvrir → reprend à la bonne position)

## 3. Sous-titres dans le player
- Le picker est implémenté mais pas testé
- Tester : sélection sous-titre externe → affichage WebVTT
- Tester : extraction sous-titre embarqué → affichage WebVTT
- Améliorer avec HLS (sous-titres natifs dans la playlist)
