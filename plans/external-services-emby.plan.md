# Plan : Connexions aux services externes (Emby en premier)

## Objectif

Permettre d'envoyer des requetes a des services externes (Emby, Jellyfin, Plex...) lors d'evenements Fliks (download termine, media ajoute, etc.). Meme philosophie que le systeme de notifications existant, mais avec des actions specifiques a chaque type de serveur (refresh de bibliotheque, etc.).

---

## Architecture

### Principe

- L'entite `MediaServer` existe deja (`backend/src/modules/users/entities/media-server.entity.ts`) avec `name`, `type` (emby/jellyfin/plex/local), `url`, `apiKey`, `enabled`.
- On ajoute un champ `events` (liste d'evenements auxquels reagir), comme pour `NotificationConnection`.
- On cree un `MediaServerService` avec CRUD + dispatch, calque sur `NotificationsService`.
- Chaque type de serveur a son propre provider (pattern strategy) qui implemente les actions concretes.
- On hook le dispatch aux memes endroits que les notifications existantes.

### Events supportes

Reutiliser les memes events que les notifications :
- `download.complete` → refresh de la bibliotheque du serveur
- `media.added` → (nouveau) notifier le serveur qu'un media est disponible
- `media.deleted` → (nouveau) notifier le serveur de supprimer le media
- `subtitle.downloaded` → refresh des metadonnees du fichier

### Ce que fait Emby a chaque event

| Event | Action Emby API |
|---|---|
| `download.complete` | `POST /Library/Refresh` (scan partiel du dossier) |
| `subtitle.downloaded` | `POST /Items/{id}/Refresh` ou `POST /Library/Refresh` |
| `media.deleted` | `POST /Library/Refresh` |

---

## Etapes d'implementation

### Etape 1 : Backend — Enrichir l'entite MediaServer

**Fichier :** `backend/src/modules/users/entities/media-server.entity.ts`

- Ajouter une colonne `events: string[]` (JSONB, default `[]`) — liste des events auxquels reagir.

### Etape 2 : Backend — Creer le module media-servers

**Nouveau dossier :** `backend/src/modules/media-servers/`

Deplacer `media-server.entity.ts` de `users/entities/` vers `media-servers/entities/` (ou le laisser en place et l'importer).

**Fichiers a creer :**

1. **`media-servers.module.ts`**
   - Imports : `TypeOrmModule.forFeature([MediaServer])`, `AuthModule`
   - Controllers : `MediaServersController`
   - Providers : `MediaServersService`, `EmbyProvider`
   - Exports : `MediaServersService`

2. **`media-servers.service.ts`** (calque sur `NotificationsService`)
   - CRUD : `create`, `findAll`, `findOne`, `update`, `remove`
   - `getTypes()` : retourne `{ type, label, supportedEvents }[]` a partir des providers enregistres (Map type → provider)
   - `dispatch(event, payload)` : filtre les connexions enabled + event matching, appelle le bon provider
   - `testConnection(id)` : teste la connexion au serveur
   - Maintient une `Map<MediaServerType, MediaServerProvider>` injectee via constructeur (un provider par type)

3. **`media-servers.controller.ts`** (calque sur `NotificationsController`)
   - `GET /media-servers/types` — retourne la liste des types avec leurs events supportes
   - `POST /media-servers` — create
   - `GET /media-servers` — findAll
   - `GET /media-servers/:id` — findOne
   - `PUT /media-servers/:id` — update
   - `DELETE /media-servers/:id` — remove
   - `POST /media-servers/:id/test` — testConnection

   L'endpoint `GET /media-servers/types` retourne :
   ```json
   [
     {
       "type": "emby",
       "label": "Emby",
       "supportedEvents": ["download.complete", "subtitle.downloaded", "media.deleted"]
     }
   ]
   ```
   Construit dynamiquement a partir du `supportedEvents` de chaque provider enregistre.

4. **`dto/create-media-server.dto.ts`**
   - `name: string`, `type: MediaServerType`, `url: string`, `apiKey: string`, `events: string[]`, `enabled: boolean`

5. **`providers/media-server-provider.interface.ts`**
   ```typescript
   export interface MediaServerProvider {
     /** Liste des events supportes par ce type de serveur */
     readonly supportedEvents: string[];
     /** Declenche un refresh de la bibliotheque (optionnellement sur un chemin specifique) */
     refreshLibrary(url: string, apiKey: string, path?: string): Promise<void>;
     /** Teste la connexion au serveur */
     testConnection(url: string, apiKey: string): Promise<{ ok: boolean; message: string }>;
   }
   ```

6. **`providers/emby.provider.ts`**
   - Implemente `MediaServerProvider`
   - `refreshLibrary` : `POST {url}/Library/Refresh?api_key={apiKey}` (refresh complet) ou `POST {url}/Library/Media/Updated?api_key={apiKey}` avec le path (refresh partiel)
   - `testConnection` : `GET {url}/System/Info?api_key={apiKey}` — verifie que le serveur repond

### Etape 3 : Backend — Hooker le dispatch

Aux memes endroits que `notifications.dispatch`, ajouter `mediaServers.dispatch` :

- **`completion.service.ts`** (~ligne 519) : apres `download.complete`, dispatch vers media servers avec le path du fichier importe
- **`subtitle-scheduler.service.ts`** (~ligne 98) : apres `subtitle.downloaded`, dispatch refresh
- **Plus tard** : ajouter les events `media.added` et `media.deleted` dans les services correspondants

**Injection :** Ajouter `MediaServersService` dans `FliksSchedulerModule` imports.

### Etape 4 : Frontend — API service

**Fichier :** `frontend/src/app/core/services/api/media-servers-api.service.ts`

```typescript
export interface MediaServerRow {
  id: number;
  name: string;
  type: string;
  url: string;
  apiKey: string;
  events: string[];
  enabled: boolean;
}
```

Methodes : `list`, `get`, `create`, `update`, `remove`, `testConnection`, `getTypes`

`getTypes()` appelle `GET /api/media-servers/types` et retourne :
```typescript
export interface MediaServerTypeInfo {
  type: string;
  label: string;
  supportedEvents: string[];
}
```

### Etape 5 : Frontend — Page settings

**Fichiers :**
- `frontend/src/app/features/settings/media-servers/media-servers.ts`
- `frontend/src/app/features/settings/media-servers/media-servers.html`

Pattern identique a `subtitle-providers` ou `notifications` settings :
- Au chargement du composant, appeler `getTypes()` pour recuperer la liste des types et leurs events supportes
- Table avec nom, type, URL, enabled, actions (edit, delete, test)
- Modal de creation/edition avec :
  - Nom
  - Type (select : Emby, Jellyfin, Plex) — les champs sont les memes pour tous
  - URL du serveur
  - Cle API
  - **Checkboxes des events** : afficher uniquement les events supportes par le type selectionne (filtre dynamique via `getTypes()`, mis a jour quand l'utilisateur change le type)
  - Bouton test de connexion
  - Enabled toggle

### Etape 6 : Frontend — Route et navigation

- Ajouter route `/settings/media-servers` dans `app.routes.ts`
- Ajouter le lien dans la sidebar (`layout.html`)
- Ajouter les cles i18n dans `fr.json`

---

## Fichiers impactes (existants)

| Fichier | Modification |
|---|---|
| `backend/src/modules/users/entities/media-server.entity.ts` | Ajout colonne `events` |
| `backend/src/app.module.ts` | Import `MediaServersModule` |
| `backend/src/modules/scheduler/completion.service.ts` | Ajout `mediaServersService.dispatch('download.complete', ...)` |
| `backend/src/modules/scheduler/subtitle-scheduler.service.ts` | Ajout dispatch `subtitle.downloaded` |
| `backend/src/modules/scheduler/scheduler.module.ts` | Import `MediaServersModule` |
| `frontend/src/app/app.routes.ts` | Ajout route settings/media-servers |
| `frontend/src/app/shared/layout/layout.html` | Ajout lien sidebar |
| `frontend/public/i18n/fr.json` | Cles i18n pour media-servers |

## Fichiers a creer

| Fichier | Description |
|---|---|
| `backend/src/modules/media-servers/media-servers.module.ts` | Module NestJS |
| `backend/src/modules/media-servers/media-servers.service.ts` | CRUD + dispatch |
| `backend/src/modules/media-servers/media-servers.controller.ts` | REST API |
| `backend/src/modules/media-servers/dto/create-media-server.dto.ts` | DTO validation |
| `backend/src/modules/media-servers/providers/media-server-provider.interface.ts` | Interface commune |
| `backend/src/modules/media-servers/providers/emby.provider.ts` | Implementation Emby |
| `frontend/src/app/core/services/api/media-servers-api.service.ts` | API frontend |
| `frontend/src/app/features/settings/media-servers/media-servers.ts` | Composant settings |
| `frontend/src/app/features/settings/media-servers/media-servers.html` | Template settings |

---

## API Emby — Endpoints utilises

| Action | Methode | Endpoint |
|---|---|---|
| Test connexion | `GET` | `/System/Info?api_key={key}` |
| Refresh complet | `POST` | `/Library/Refresh?api_key={key}` |
| Refresh partiel | `POST` | `/Items/{itemId}/Refresh?api_key={key}` |

La cle API Emby se passe en query param `api_key` ou en header `X-Emby-Token`.

---

## Extensibilite future

- **Jellyfin** : API quasi identique a Emby (meme endpoints, header `X-Emby-Token` ou `Authorization: MediaBrowser Token="{key}"`)
- **Plex** : `GET /library/sections/{id}/refresh?X-Plex-Token={token}`
- Chaque nouveau serveur = un nouveau fichier provider implementant `MediaServerProvider`
