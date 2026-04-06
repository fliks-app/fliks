# Gestion du ratio de seed

Fliks supprime automatiquement les torrents de qBittorrent une fois qu'ils ont atteint leur objectif de seed et que l'import est termine.

## Configuration

Chaque indexeur a deux parametres optionnels dans ses settings :

| Parametre | Type | Defaut | Description |
|---|---|---|---|
| `seedRatio` | number | 1.0 | Ratio upload/download minimum avant suppression |
| `maxRetentionDays` | number | aucun | Nombre de jours maximum apres lequel le torrent est supprime, independamment du ratio |

Ces parametres sont configures dans **Settings > Indexers > Modifier un indexer**.

## Fonctionnement

Le job `CleanSeeded` tourne **chaque minute** et execute la logique suivante :

```
Pour chaque torrent importe (status = 'completed') :
  1. Trouver le torrent correspondant dans qBittorrent (via torrentHash)
  2. Recuperer l'indexeur d'origine (via indexerId dans download_history)
  3. Lire seedRatio et maxRetentionDays depuis les settings de l'indexeur
  4. Verifier les conditions de suppression :
     a. Si maxRetentionDays est defini ET (now - completion_on) >= maxRetentionDays
        → Supprimer (sans verifier le ratio)
     b. Sinon si torrent.ratio >= seedRatio
        → Supprimer
  5. Supprimer le torrent + les fichiers de qBittorrent
```

## Priorite des conditions

La retention max est verifiee **en premier**. Si elle est atteinte, le torrent est supprime sans attendre le ratio. Cela permet de limiter l'espace disque utilise meme si le ratio n'est jamais atteint (torrent peu populaire).

Si aucune retention max n'est definie, seul le ratio est verifie.

## Prerequis

- Le torrent doit avoir ete **importe avec succes** (`status = 'completed'`). Les torrents en cours de telechargement ou en erreur ne sont pas concernes.
- L'indexeur doit etre renseigne dans l'historique de telechargement (`indexerId`). Si l'indexeur a ete supprime, le ratio par defaut de 1.0 est utilise.
- Les fichiers du torrent sont deja copies dans la mediatheque lors de l'import. La suppression ne concerne que les fichiers dans le repertoire de telechargement de qBittorrent.

## Fichiers concernes

| Fichier | Role |
|---|---|
| `completion.service.ts` | Methode `cleanSeededTorrents()` — logique de nettoyage |
| `scheduler.service.ts` | Job `CleanSeeded` enregistre (chaque minute) |
| `qbittorrent.service.ts` | Interface `QbittorrentTorrent.ratio` + `deleteTorrent()` |
| `indexer.entity.ts` | Settings JSONB (`seedRatio`, `maxRetentionDays`) |
| `download-history.entity.ts` | `indexerId` pour retrouver l'indexeur d'origine |
| `indexers.ts` / `indexers.html` | Formulaire frontend pour configurer les parametres |

## Exemple de log

```
[CompletionService] SeedCleanup: removing "Movie.2024.1080p.BluRay" (ratio 1.05 >= 1)
[CompletionService] SeedCleanup: removing "Series.S01.720p.WEB" (retention 8d >= 7d)
```
