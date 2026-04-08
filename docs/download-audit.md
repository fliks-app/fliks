# Download System Audit & Restructuration

## Problèmes critiques identifiés

### 1. Triple source de vérité
Le statut d'un download est tracké à 3 endroits indépendants :
- **Serveur** : `DownloadTask.status` (DB)
- **Cache localStorage** : `downloadCache.load()` (snapshot)
- **Signal in-memory** : `downloadCache.activeDownloads()` (device DL progress)

Divergent facilement. Pas de stratégie d'invalidation.

### 2. Duplication `onDownload()`
`media-detail.ts` et `episode-detail.ts` ont le même code (33-40 lignes chacun). Seule différence : le titre de l'épisode.

### 3. Race conditions notifications
- Dismissed list effacée pendant le startup → SSE events entre-temps peuvent recréer des notifs fantômes
- `startService()` appelé depuis plusieurs endroits sans reference counting → `stopService()` prématuré possible

### 4. Pas de reprise device download
Si le réseau tombe pendant un device download → échec silencieux. Pas de retry automatique au retour du réseau.

### 5. Lifecycle service fragile
Wake lock de 30min. Si l'app est kill pendant un download → wake lock tenu jusqu'au timeout. Pas de cleanup propre.

### 6. Erreurs sous-titres silencieuses
VTT download errors swallowed (`.catch(() => {})`). Pas de retry, pas de feedback UI.

---

## Restructuration proposée

### Principe : **serveur = source de vérité unique**

Le frontend ne cache que le minimum (titres pour notifs, fichiers locaux pour offline). Tout le reste vient du serveur via poll ou SSE.

### Changements

#### 1. Fusionner `onDownload()` dans `DownloadManagerService`

```ts
class DownloadManagerService {
  async createDownload(mediaFileId: number, quality: string, title: string): Promise<DownloadTask> {
    const dp = this.deviceProfile.getProfile();
    const task = await this.downloadsApi.create(mediaFileId, quality, { ... });
    this.taskTitles.set(task.id, title);
    this.downloadCache.save([...this.downloadCache.load().filter(t => t.id !== task.id), task]);
    this.notif.startService();
    this.notif.show(task.id, title, 0, task.status === 'ready' ? 'downloading' : 'transcoding');
    if (task.status === 'ready') void this.handleReady(task.id);
    return task;
  }
}
```

`media-detail` et `episode-detail` appellent juste `downloadManager.createDownload(fileId, quality, title)`.

#### 2. Simplifier le state management

Supprimer :
- `downloadCache.getDismissed()` / `markDismissed()` → remplacé par delete serveur immédiat
- `lastProgressAt` Map → remplacé par un poll serveur périodique (30s) au lieu du stall detection
- `activeDownloads` signal reste (pour UI progress en temps réel)

Le cache localStorage ne sert QUE pour l'offline. En online, tout vient de l'API.

#### 3. Simplifier le recovery

```
Au startup :
  1. dismissAll notifications
  2. stopService
  3. Si online → list() API, mettre à jour cache
  4. Pour chaque task 'ready' sans fichier local → handleReady (avec notif)
  5. Pour chaque task 'transcoding' → startService + show notif
  6. Supprimer les 'failed' du serveur
  
Au resume :
  1. reconnect SSE
  2. list() API → diff avec état connu → update notifs
```

#### 4. Reference counting pour le service

```ts
private activeTaskCount = 0;

startTracking(taskId) { this.activeTaskCount++; this.notif.startService(); }
stopTracking(taskId) { this.activeTaskCount--; if (this.activeTaskCount <= 0) this.notif.stopService(); }
```

#### 5. Auto-resume device downloads

Écouter `window.addEventListener('online')` dans `DownloadManagerService`. Au retour du réseau → re-check les tasks `ready` sans fichier local et relancer.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `download-manager.service.ts` | Refactor majeur : fusionner onDownload, simplifier recovery, ref counting |
| `download-cache.service.ts` | Supprimer dismissed logic, garder seulement cache + activeDownloads |
| `media-detail.ts` | Remplacer onDownload par `downloadManager.createDownload()` |
| `episode-detail.ts` | Idem |
| `downloads.ts` (page) | Simplifier SSE handler, supprimer retry (dans manager) |
| `download-notification.service.ts` | Inchangé |
| `offline-storage.service.ts` | Inchangé |
| `DownloadForegroundService.java` | Inchangé |
| `DownloadNotificationPlugin.java` | Inchangé |
