# Suitarr — Plan correctifs sous-titres

## 1. Corriger l'emplacement de téléchargement des sous-titres

Actuellement le sous-titre est sauvegardé en utilisant `relativePath` du MediaFile, ce qui ne correspond pas au chemin absolu réel sur le disque. Il faut :

- [ ] Résoudre le chemin absolu du fichier média en combinant le `path` du Media (root folder) + `relativePath` du MediaFile
- [ ] Sauvegarder le fichier `.srt` à côté du fichier vidéo (même dossier, même nom de base)
- [ ] Vérifier que le dossier de destination existe avant d'écrire
- [ ] Stocker le chemin absolu complet dans `SubtitleFile.filePath`
- [ ] Mettre à jour `SubtitlesService.downloadSubtitle()` et le `MediaController` qui passe le chemin

## 2. Corriger les sous-titres pour les séries

Les séries ont une structure épisode/saison qui n'est pas correctement gérée :

- [ ] Passer `season` et `episode` number dans les `SubtitleSearchParams` lors de la recherche depuis le frontend
- [ ] Dans le `MediaController`, résoudre l'épisode et la saison à partir de `episodeId` pour alimenter les params de recherche
- [ ] Permettre la recherche de sous-titres par épisode dans la page media-detail (sélecteur d'épisode dans la modale)
- [ ] Afficher les sous-titres groupés par épisode dans la section sous-titres des séries
- [ ] S'assurer que le `SubtitleSearchJob` du scheduler itère correctement les épisodes des séries (pas seulement les films)
- [ ] Nommer le fichier sous-titre avec le pattern série : `Title.S01E01.fr.srt`
