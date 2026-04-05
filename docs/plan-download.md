# Feature: Download / Conversion offline

## Concept
Permettre aux utilisateurs de télécharger un média dans une qualité spécifique choisie depuis le frontend (ex: "Télécharger en 1080p").

## Prérequis
- Queue de transcoding prioritaire dans `TranscodingService`

## Queue prioritaire GPU
- **Priorité haute** : streams live (playback en cours) — passent immédiatement
- **Priorité basse** : jobs de download/conversion — attendent qu'un slot GPU se libère
- Si un stream live arrive et que le GPU est saturé par des downloads → pause/kill du download le plus récent pour libérer un slot
- Inspiré du système "Optimize" de Plex

## À définir
- Format de sortie (MP4 avec H.264 ? choix utilisateur ?)
- Stockage des fichiers convertis (temporaire ? permanent ?)
- Notification quand le download est prêt
- Limite de downloads simultanés par utilisateur
- Nettoyage automatique des fichiers convertis après X jours
