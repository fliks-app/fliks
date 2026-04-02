# Plan : Améliorations sous-titres — Parité Bazarr

## Context
Suitarr a déjà une base solide (6 providers, scoring, upgrade auto, sync ffsubsync/alass, embedded detection, language profiles). Ce plan identifie les features Bazarr manquantes à implémenter.

---

## Fonctionnalités existantes (OK)
- Providers : OpenSubtitles, Subdl, Supersubtitles, Subsynchro, YIFY, Gestdown
- Recherche auto (6h), upgrade auto (12h)
- Scoring 0-100, seuil min + upgrade threshold
- Détection embedded (ffprobe)
- Forced / Hearing Impaired flags
- Re-encodage UTF-8
- Sync timing (ffsubsync/alass)
- Profils de langue avec options par langue
- Stats par provider, historique activité

---

## 1. Anti-captcha / rate-limiting provider
Bazarr gère les limites de l'API OpenSubtitles (quotas, cooldowns). Suitarr devrait :
- Tracker les quotas restants par provider (OpenSubtitles = 40 downloads/24h pour les comptes gratuits)
- Respecter les `Retry-After` headers
- Mettre en pause un provider temporairement si quota atteint

## 2. Recherche par hash du fichier vidéo
Bazarr calcule le hash du fichier vidéo (OpenSubtitles hash algorithm) pour trouver des sous-titres parfaitement matchés.
- Implémenter le hash OpenSubtitles (`moviehash` = XOR des 64 premiers + 64 derniers KiB)
- Envoyer `moviehash` + `moviebytesize` dans les recherches OpenSubtitles
- Les résultats matchés par hash ont un score bonus (+20)

## 3. Exclusions de mots / anti-ads
Bazarr permet de filtrer les sous-titres contenant de la publicité (HI tags inutiles, pubs intégrées).
- Setting global : liste de regex à exclure des résultats de recherche
- Post-download : nettoyer les lignes de pub (regex configurable)
- Supprimer les tags HI inutiles `[music playing]`, `♪`, etc. (option)

## 4. Intervalle de recherche configurable
L'intervalle de recherche (6h) et d'upgrade (12h) sont hardcodés dans les cron expressions.
- Settings : `subtitle_search_interval` (minutes, défaut 360)
- Settings : `subtitle_upgrade_interval` (minutes, défaut 720)
- Utiliser `@Interval()` au lieu de `@Cron()` pour les rendre dynamiques

## 7. Blacklist de sous-titres
Bazarr permet de blacklister un sous-titre (mauvais sync, mauvaise langue) pour ne pas le re-télécharger.
- Nouvelle entité `SubtitleBlacklist` (providerType, providerFileId, mediaId, reason)
- Filtrer les résultats de recherche contre la blacklist
- UI : bouton "Blacklister" sur chaque sous-titre téléchargé

## 8. File d'attente de sync + options avancées
Quand beaucoup de sous-titres sont téléchargés en même temps, les syncs ffsubsync s'empilent.
- Implémenter une queue de sync avec concurrence limitée (1-2 en parallèle)
- Afficher l'état de la queue dans l'UI (en attente, en cours, terminé)
- Option : utiliser Redis (BullMQ) si disponible, sinon queue en mémoire

**Modal de sync (inspirée Bazarr)** — options exposées à l'utilisateur avant de lancer un sync :
- **Référence** : choix de la piste de référence (défaut : auto depuis le fichier vidéo, ou une autre piste audio/sous-titre du fichier)
- **Max Offset Seconds** : limite du décalage max autorisé (ex: 60s) — évite les syncs aberrants
- **No Fix Framerate** : checkbox — désactiver la correction de framerate (utile si le sub est déjà au bon FPS)
- **Golden-Section Search** : checkbox — algorithme alternatif de recherche de décalage (plus lent, plus précis pour les cas difficiles)

## 9. Détection de la langue du fichier vidéo
Bazarr peut détecter la langue audio du fichier vidéo via ffprobe pour adapter la recherche.
- Parser les streams audio de ffprobe pour extraire la langue
- Utiliser cette info pour ne pas chercher des sous-titres dans la langue audio principale

## 10. Post-processing avancé
- **Décalage manuel** : permettre à l'utilisateur d'ajuster le timing (+/- secondes) via l'UI
- **Conversion de format** : SSA/ASS → SRT automatique
- **Merge** : fusionner forced + regular si les deux existent

## 12. Actions sur les sous-titres (menu contextuel Bazarr)
Actions disponibles par sous-titre téléchargé, accessibles via un menu contextuel dans l'UI :
- **Sync** : lancer ffsubsync/alass (déjà implémenté)
- **Remove HI Tags** : supprimer les tags hearing impaired `[music]`, `(sighs)`, `♪`, etc.
- **Remove Style Tags** : supprimer les balises de style `<i>`, `<b>`, `<font>`, `{\\an8}`, etc.
- **Remove Emoji** : supprimer tous les emojis/caractères spéciaux
- **OCR Fixes** : corriger les erreurs OCR courantes (`l` → `I`, `rn` → `m`, `0` → `O`, etc.)
- **Common Fixes** : corrections typographiques (double espaces, ponctuation, lignes vides, etc.)
- **Fix Uppercase** : convertir les sous-titres tout en majuscules en casse normale
- **Reverse RTL** : inverser le texte pour les langues RTL (arabe, hébreu)
- **Add Color** : ajouter une couleur au texte (dialogue, narrateur)
- **Change Frame Rate** : convertir les timings entre frame rates (23.976 ↔ 25 ↔ 29.97)
- **Adjust Times** : décalage +/- millisecondes sur tous les timings
- **Translate** : traduire le sous-titre via API (LibreTranslate, DeepL, Google)

## 11. Notifications granulaires
- Notification quand un sous-titre est trouvé / upgradé / échoué (par type)
- Event types : `subtitle.downloaded`, `subtitle.upgraded`, `subtitle.failed`, `subtitle.synced`

---

## Ordre d'implémentation recommandé
1. Intervalle configurable (rapide, utile immédiatement)
2. Hash fichier vidéo (améliore significativement la qualité des résultats)
3. Rate-limiting (évite les bans provider)
4. Blacklist sous-titres (UX critique)
5. Anti-ads
6. Détection langue audio
7. File d'attente de sync (Redis/BullMQ ou in-memory)
9. Post-processing avancé
10. Actions sous-titres (menu contextuel)
11. Notifications granulaires
