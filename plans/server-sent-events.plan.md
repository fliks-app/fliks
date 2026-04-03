# Plan : Étendre le système Server-Sent Events

## Context
Un système SSE existe déjà :
- **Backend** : `EventsService` (RxJS Subject) + endpoint `GET /api/system/events` via `@Sse`
- **Frontend** : `SseService` (EventSource) + signal `activeProgress`
- **Utilisé pour** : TaskProgress (commandes scheduler : SearchMissing, RefreshMetadata, etc.)

Le système ne gère qu'un seul type d'événement (`TaskProgress`). Il faut l'étendre pour supporter tous les événements temps réel.

---

## Étape 1 : Typer les événements backend

**Fichier** : `backend/src/modules/scheduler/events.service.ts`

Remplacer `TaskProgress` par un union type d'événements :

```typescript
export type SseEvent =
  | { type: 'task.progress'; command: string; current: number; total: number; message: string }
  | { type: 'subtitle.synced'; subtitleId: number; language: string }
  | { type: 'subtitle.downloaded'; mediaId: number; title: string; language: string; provider: string }
  | { type: 'subtitle.failed'; mediaId: number; title: string; language: string; error: string }
  | { type: 'download.complete'; mediaId: number; title: string }
  | { type: 'import.complete'; mediaId: number; title: string }
  | { type: 'import.failed'; mediaId: number; title: string; error: string }
  | { type: 'request.approved'; requestId: number; title: string }
  | { type: 'request.declined'; requestId: number; title: string }
  | { type: 'stalled.removed'; title: string }
  | { type: 'queue.updated' }; // Signal to refresh queue UI
```

La méthode `emit()` accepte un `SseEvent` au lieu de `TaskProgress`.

---

## Étape 2 : Émettre les événements depuis les services existants

Les services émettent déjà des notifications via `NotificationsService.dispatch()` (pour les webhooks externes). Ajouter en parallèle un `eventsService.emit()` pour le SSE interne :

- **CompletionService** : `import.complete`, `import.failed`, `stalled.removed`
- **SubtitleSyncService** : `subtitle.synced` (déjà en notification, ajouter SSE)
- **SubtitleSchedulerService** : `subtitle.downloaded`, `subtitle.failed`
- **RequestsService** : `request.approved`, `request.declined`
- **DownloadClientsService** : `queue.updated` (après ajout/suppression de torrent)
- **SchedulerService** : `task.progress` (déjà fait)

L'idée : `EventsService` est léger (in-process, pas de persistence), `NotificationsService` est pour les webhooks externes (Discord, Gotify, etc.).

---

## Étape 3 : Enrichir le frontend SseService

**Fichier** : `frontend/src/app/core/services/sse.service.ts`

- Parser le `type` de chaque événement
- Exposer des signals par catégorie :
  - `activeProgress` (déjà existant, pour les barres de progression)
  - `lastEvent` signal pour les composants qui veulent réagir
- Injecter `ToastService` pour afficher des toasts automatiques sur certains événements :
  - `subtitle.synced` → toast success "Sous-titre synchronisé"
  - `import.complete` → toast success "Import terminé"
  - `import.failed` → toast error "Import échoué"
  - `queue.updated` → pas de toast, juste refresh la page queue
- L'URL SSE doit utiliser `ServerConfigService.resolveUrl()` pour le mode Capacitor Android

---

## Étape 4 : Rafraîchissement automatique des composants

Les composants peuvent s'abonner aux événements pour se rafraîchir :

- **Queue** : sur `queue.updated` → `refreshQueue()`
- **Media detail subtitles** : sur `subtitle.synced` / `subtitle.downloaded` → `loadSubtitles()`
- **Requests page** : sur `request.approved` / `request.declined` → `reload()`

Pattern : chaque composant injecte `SseService` et utilise `effect()` pour réagir aux changements de `lastEvent`.

---

## Étape 5 : Auth sur le SSE

Le endpoint SSE actuel (`@Sse('events')`) est protégé par `JwtOrApiKeyGuard`. Mais `EventSource` ne peut pas envoyer de headers.

Solutions :
- **Cookie auth** (web) : fonctionne déjà car `EventSource` envoie les cookies automatiquement
- **Token en query param** (Android/natif) : `new EventSource('/api/system/events?token=xxx')`
- Adapter le guard pour accepter un token en query string pour le SSE

---

## Fichiers à modifier
- `backend/src/modules/scheduler/events.service.ts` — typer les événements
- `backend/src/modules/scheduler/completion.service.ts` — émettre import events
- `backend/src/modules/subtitles/subtitle-sync.service.ts` — émettre subtitle.synced
- `backend/src/modules/scheduler/subtitle-scheduler.service.ts` — émettre subtitle events
- `frontend/src/app/core/services/sse.service.ts` — parser les types, toasts auto
- `frontend/src/app/features/activity/queue/queue.ts` — refresh auto sur queue.updated

## Estimation
- Backend (typage + émission) : ~2h
- Frontend (parsing + toasts + refresh) : ~2h
- Auth SSE natif : ~1h
