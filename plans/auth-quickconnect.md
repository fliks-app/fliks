# Auth & connectivity — trim, quick connect, server history (+ mDNS futur)

## Context

Quatre demandes liées au flow login / connexion serveur:

1. **Trim** dans le form de login (espaces parasites coupent l'auth).
2. **Quick connect**: se logger sur TV en validant le code depuis un appareil déjà loggé (à la Plex, Spotify, Netflix). Le clavier de la TV est pénible — ce flow doit l'éviter.
3. **Historique des serveurs** sur les apps natives: lister les serveurs précédemment utilisés pour restaurer une connexion en un tap, au lieu de re-saisir l'URL.
4. **(Futur)** Auto-discovery mDNS/Bonjour des serveurs Fliks sur le LAN.

Les trois premières features sont packées en deux PRs. La 4e est juste esquissée.

---

## 1. Trim du form login (PR1, trivial)

**Fichier**: `frontend/src/app/features/login/login.ts:38-40`

```ts
const { username, password } = this.form.getRawValue();
await this.auth.login(username, password);
```

→

```ts
const { username, password } = this.form.getRawValue();
await this.auth.login(username.trim(), password);
```

Note: on **trim seulement le username**, pas le mot de passe (un mot de passe peut légitimement contenir des espaces en début/fin pour certains coffres). C'est le comportement de Plex/Jellyfin.

**Ailleurs** dans le repo où l'username/email est saisi: `setup.ts:30` fait déjà `.trim()` sur l'URL. Pas de page register côté frontend (commentée dans `auth.controller.ts`). RAS.

---

## 2. Historique des serveurs (PR1)

### 2.1 — Modèle de stockage

**Fichier**: `frontend/src/app/core/services/server-config.service.ts`

Aujourd'hui:
```
fliks_server_url: "http://192.168.1.10:3000"   (string unique)
```

Cible:
```
fliks_server_url: "http://192.168.1.10:3000"        (actif, inchangé)
fliks_known_servers: [                              (nouveau)
  { url: "http://192.168.1.10:3000", name: null, lastUsedAt: 1714200000000, lastUsername: "clement" },
  { url: "https://fliks.example.com", name: "Maison", lastUsedAt: 1714000000000, lastUsername: null }
]
```

Pourquoi garder `fliks_server_url` séparé: tous les services existants (`resolveUrl()`, `auth.service`, `sse.service`, `streaming-api.service`) lisent ce champ. Un changement de schéma casserait tout. On ne touche **rien** au champ existant; on ajoute un index latéral.

### 2.2 — API du service

```ts
interface KnownServer {
  url: string;
  name: string | null;        // alias affiché si user l'a nommé
  lastUsedAt: number;
  lastUsername: string | null; // pour pré-remplir l'input login
}

class ServerConfigService {
  // ... existant ...
  readonly knownServers = signal<KnownServer[]>([]);

  async loadKnownServers(): Promise<void>;          // appelé par load()
  async addOrTouchKnownServer(url: string, opts?: { name?: string; username?: string }): Promise<void>;
  async forgetKnownServer(url: string): Promise<void>;
  async renameKnownServer(url: string, name: string): Promise<void>;
}
```

- **Quand on ajoute**: après login réussi (dans `auth.service.login()`), on appelle `serverConfig.addOrTouchKnownServer(activeUrl, { username })`.
- **Setter `name`**: optionnel pour l'utilisateur via le bouton "Renommer" sur l'entrée.
- **Forget**: bouton corbeille à côté de l'entrée; ne supprime pas si c'est le serveur actif (on prévient via toast).
- **Tri**: `lastUsedAt desc`, max 10 entrées (FIFO sur dépassement).

### 2.3 — UX setup page

**Fichier**: `frontend/src/app/features/setup/setup.html` (et `.ts`)

Ajout d'une section **au-dessus** de l'input URL, visible seulement si `knownServers().length > 0`:

```
┌─────────────────────────────────────────────────┐
│ Serveurs récents                                │
├─────────────────────────────────────────────────┤
│ 🏠 Maison       fliks.example.com    [Utiliser] │  ← clic ligne ou bouton
│    (clement, il y a 3 jours)            [⋯]    │  ← menu: Renommer / Oublier
│                                                 │
│ 📡 192.168.1.10:3000                  [Utiliser]│
│    (il y a 2 semaines)                  [⋯]    │
└─────────────────────────────────────────────────┘
```

Cliquer "Utiliser" → set `serverConfig.serverUrl` direct (sans repasser par le test) ET pre-remplit l'input URL (au cas où l'utilisateur veut éditer). Puis navigate `/login` avec `lastUsername` pré-rempli.

### 2.4 — Pré-remplissage username au login

**Fichier**: `frontend/src/app/features/login/login.ts`

```ts
readonly form = this.fb.nonNullable.group({
  username: [this.serverConfig.lastUsernameForActiveServer() ?? '', Validators.required],
  password: ['', Validators.required],
});
```

Petit + UX: pas besoin de retaper le username quand on revient sur un serveur connu.

### 2.5 — Mode web

Web aussi: stockage `localStorage`. La feature est plus utile sur natif (multi-server) mais le code est presque le même (déjà gardé en sym Preferences/localStorage par le service).

---

## 3. Page de sélection d'utilisateur (PR2 — préalable au quick connect)

> Inspiration Plex / Jellyfin / Netflix profile picker. Devient le **point d'entrée par défaut** sur tous les form-factors (web, natif, TV).

### 3.1 — Backend

`GET /auth/users-public` (sans auth)

Réponse:
```json
[
  { "id": 1, "username": "clement", "avatar": "/api/users/1/avatar" },
  { "id": 2, "username": "alice",   "avatar": null }
]
```

- Ne renvoie que les users `enabled: true`.
- Ne renvoie **rien d'autre** que id/username/avatar (pas d'email, pas de role, pas de lastLogin).
- Implémentation: nouvelle méthode `usersService.publicList()` filtrant les colonnes via `select`.

Aucune réflexion plus poussée sur la confidentialité — le serveur est familial, on aligne sur le standard Plex/Jellyfin (qui exposent la liste par défaut). Si le besoin se fait sentir plus tard, ajouter un setting `app_settings.public_user_list` (hors-scope ici).

### 3.2 — Frontend

**Nouvelle route**: `/select-user` (lazy module `features/select-user/`).

**Routing change** dans `app.routes.ts`:
- Avant: redirection après setup → `/login`.
- Après: redirection après setup → `/select-user`.
- `/login` reste accessible (deep link) avec username pré-rempli en query param `?username=clement`.

**Page UX**:
- Grille de cards (avatar + username) — même `app-media-card` ne convient pas, on fait un composant dédié `app-user-card` plus simple.
- Clic sur user → bottom sheet (mobile) / dropdown (desktop/TV) avec deux options:
  - **"Mot de passe"** → navigate `/login?username=clement` (form pré-rempli + verrouillé sur le username).
  - **"Connexion via téléphone"** → lance la flow quick connect (cf. §4).
- Bouton "Saisir un autre utilisateur" en bas → navigate `/login` vide (pour comptes invisibles type service).
- Bouton "Changer de serveur" en bas (sur natif uniquement, comme aujourd'hui).

**Avatars**: réutilise le champ `User.avatar` existant. Si null, afficher initiales sur fond coloré dérivé du username (helper `initialsAvatar(username)` qui hash le nom en HSL).

**TV (D-pad)**: la grille est focusable, les options du bottom sheet aussi — focus management déjà couvert par `TvSpatialNavService` (rien à ajouter, juste vérifier).

---

## 4. Quick connect (PR2 — pas de code, validation par page dédiée)

> Décision UX: **pas de code à saisir**. La TV émet une demande nommée; le téléphone affiche les demandes en attente sur une page dédiée et l'utilisateur approuve/refuse. SSE pour la mise à jour live (bonus, fonctionne sans).

### 4.1 — Modèle UX

**TV** (non loggée, après sélection user):
- Écran "En attente de validation depuis votre téléphone" avec:
  - Spinner + nom de l'appareil ("Sony Bravia X90 — Salon")
  - Sous-titre: "Ouvrez Fliks sur votre téléphone → menu → Demandes de connexion"
  - Compte à rebours 10 min
  - Bouton "Annuler" (revient à `/select-user`)
- En arrière-plan: `POST /auth/pairing/request { userId, deviceName }` à l'init, puis polling `GET /auth/pairing/status/:pairingId` toutes les 2 s.
- À `approved`: récupère l'`accessToken`, stocke comme login normal, navigate `/`.
- À `denied` ou timeout: message + bouton "Réessayer".

**Téléphone** (loggé):
- Nouvelle entrée menu user: **"Demandes de connexion"** avec badge si pending count > 0.
- Page `/pending-requests`:
  - Au mount: `GET /auth/pairing/pending` → liste des demandes en attente pour le user courant.
  - SSE bonus: écoute l'event `pairing.requested` et met à jour la liste sans rafraîchir.
  - Si liste vide: "Aucune demande en attente" + dessin sympa.
  - Si demandes: cartes `[deviceName] [il y a 2 min] — [Approuver] [Refuser]`.
- Si l'utilisateur arrive sur la page sans pending: c'est OK, c'est juste une page d'inspection.

**Pas de notification système** — l'UX est explicite: l'utilisateur ouvre Fliks et va sur la page. SSE évite l'attente d'un refresh manuel quand l'app est déjà ouverte.

### 4.2 — Backend

**Nouveau module**: `backend/src/modules/auth/pairing/`

#### 4.2.1 — Entity `PairingRequest`

`pairing/entities/pairing-request.entity.ts`:

```ts
@Entity('pairing_requests')
export class PairingRequest extends BaseEntity {
  @Column({ unique: true })
  @Index()
  publicId: string;                    // UUID — exposé dans l'URL côté TV

  @Column()
  @Index()
  userId: number;                      // user que la TV veut logger (choisi sur le user picker)

  @Column()
  @Index()
  deviceId: string;                    // UUIDv4 stable per-install (Preferences: fliks_device_id)

  @Column()
  deviceName: string;                  // "Sony Bravia X90", dérivé de l'UA + form-factor

  @Column({ type: 'enum', enum: ['pending','approved','denied','expired'], default: 'pending' })
  status: 'pending' | 'approved' | 'denied' | 'expired';

  @Column({ nullable: true })
  approvedByUserId: number;

  @Column({ type: 'text', nullable: true })
  accessToken: string;                 // JWT issu pour la TV à l'approbation, nullé après lecture

  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
```

`synchronize: true` actif → table créée au prochain redémarrage, pas de migration manuelle (`backend/src/app.module.ts`).

#### 4.2.2 — Endpoints

| Méthode | Route | Auth | Body / Query | Réponse |
|---|---|---|---|---|
| POST | `/auth/pairing/request` | aucune | `{ userId, deviceName }`, header `X-Device-Id` | `{ pairingId, expiresIn }` |
| GET | `/auth/pairing/status/:pairingId` | aucune | header `X-Device-Id` | `{ status, accessToken? }` (token retourné 1 fois) |
| GET | `/auth/pairing/pending` | JWT | — | `[{ pairingId, deviceName, deviceId, requestedAt }]` (filtré sur `userId === me`) |
| POST | `/auth/pairing/:pairingId/approve` | JWT | — | `204` |
| POST | `/auth/pairing/:pairingId/deny` | JWT | — | `204` |

Notes:
- `pairingId` = UUID public, **non-secret en soi** mais combiné au `X-Device-Id` pour récupérer le token. Sans le `deviceId` qui a fait le `request`, status renvoie `{ status }` sans token.
- `pending` est filtré au `userId` du JWT — un user ne voit que les demandes qui le concernent.
- `approve` exige que `request.userId === jwt.userId` (sinon 403): un attaquant loggé ne peut pas approuver une demande visant un autre user.
- TTL 10 min. Expired calculé à la lecture (lazy).
- Throttling: max 3 requests pending par `deviceId`; `@nestjs/throttler` 10 requests/IP/minute.
- Cleanup `@Cron('0 * * * *')` supprime les rows `expiresAt < now()`.

#### 4.2.3 — Service

`pairing/pairing.service.ts`:

```ts
@Injectable()
export class PairingService {
  async request(userId: number, deviceId: string, deviceName: string): Promise<{ pairingId: string; expiresIn: number }>;
  async status(pairingId: string, deviceId: string): Promise<{ status; accessToken?: string }>;
  async listPendingForUser(userId: number): Promise<PairingRequestDto[]>;
  async approve(pairingId: string, user: User): Promise<void>;  // génère JWT, status=approved
  async deny(pairingId: string, user: User): Promise<void>;
  @Cron('0 * * * *') async cleanupExpired(): Promise<void>;
}
```

L'`accessToken` issu à `approve()` est généré exactement comme un login classique (`authService` exposera une méthode `signTokenFor(user)` qu'on partage). TTL = `JWT_EXPIRATION` (7d par défaut).

#### 4.2.4 — SSE bonus

Ajouter le type d'event `pairing.requested` dans `backend/src/modules/scheduler/events.service.ts`:

```ts
{ type: 'pairing.requested', userId: number, pairingId: string, deviceName: string, deviceId: string }
```

Émis à la fin de `PairingService.request()`. Côté frontend, le SSE service filtre déjà par session (l'event est livré sur le canal authentifié de tous les clients). Pour cibler **uniquement le user concerné**, on ajoute un check dans le handler frontend: ignore si `event.userId !== currentUser.id`. (Le filtrage strict côté backend nécessiterait un broadcast typé par user, refactor plus large — pas indispensable, l'event est innocent en lecture.)

#### 4.2.5 — Sécurité

- **Sans `X-Device-Id` correspondant au creator**: lire `status` retourne `{ status }` sans token. Donc même si un attaquant connaît le `pairingId` (URL leak), il ne peut pas récupérer un token approuvé.
- **Approve par un autre user**: 403 (check `request.userId === jwt.userId`).
- **Spam de demandes**: rate limit + max 3 pending par `deviceId`. Un user X ne peut pas spammer la page `/pending-requests` du user Y avec des centaines de demandes.
- **Brute force `pairingId`**: UUID v4, espace 122 bits — pas brute-forçable même si on enlève le check device.
- **Token en BDD en clair**: stocké le temps que la TV poll, puis nullé. Risque limité à la fenêtre approve→poll (max 2 s en pratique). Acceptable pour un media server self-hosted.

### 4.3 — Frontend

#### 4.3.1 — Helper `device-info`

`frontend/src/app/core/utils/device-info.ts` — centralise:
- `getOrCreateDeviceId()`: UUID v4 persisté dans Preferences sous `fliks_device_id` (généré une fois).
- `getDeviceName()`: chaîne lisible dérivée de l'UA + `DeviceService.formFactor()`:
  - TV: "Sony Bravia X90" (parse UA), fallback "Android TV"
  - Tablet: "Samsung Galaxy Tab" (UA model), fallback "Tablette Android"
  - Phone: "iPhone 14 Pro" / "Pixel 8", fallback "Téléphone"
  - Desktop: "Chrome — macOS", "Firefox — Windows"

#### 4.3.2 — `auth.service.ts` — nouvelles méthodes

```ts
async listUsersPublic(): Promise<PublicUserSummary[]>;

async pairingRequest(userId: number, deviceName: string): Promise<{ pairingId: string; expiresIn: number; deviceId: string }>;
async pairingPollStatus(pairingId: string, deviceId: string): Promise<{ status; accessToken?: string }>;
async pairingPending(): Promise<PendingRequest[]>;
async pairingApprove(pairingId: string): Promise<void>;
async pairingDeny(pairingId: string): Promise<void>;

/** Reuse internal _afterLoginSuccess({ user, accessToken }) so the pairing
    success path matches the password login path (token storage + redirect). */
async loginWithToken(accessToken: string): Promise<void>;
```

#### 4.3.3 — Composants

| Route | Composant | Rôle |
|---|---|---|
| `/select-user` | `SelectUserComponent` | Grille users + bottom sheet d'options (cf. §3.2) |
| `/login` | `LoginComponent` (existant) | Form mot de passe; lit `?username=` du query |
| `/quick-connect/:userId` | `QuickConnectWaitComponent` | Écran d'attente côté TV (créé par "Connexion via téléphone") |
| `/pending-requests` | `PendingRequestsComponent` | Liste des demandes côté téléphone, Approve/Deny |

**`QuickConnectWaitComponent`**:
- À l'init: `pairingRequest(userId, deviceName)` → stocke `pairingId` et `deviceId`.
- Polling RxJS `timer(2000, 2000).pipe(switchMap(() => pollStatus()), takeUntil(approved or denied or expired))`.
- À `approved`: `auth.loginWithToken(accessToken)` → navigate `/`.
- Bouton "Annuler" → navigate `/select-user` (le pairing reste en pending et expirera tout seul, ou on appelle un `cancel` côté backend en bonus).

**`PendingRequestsComponent`**:
- À l'init: `auth.pairingPending()`.
- Listener SSE pour `pairing.requested` (refetch ou append à la liste si event.userId === me).
- Cards d'item:
  ```
  ┌──────────────────────────────────────┐
  │ 📺  Sony Bravia X90                  │
  │     Demande reçue il y a 10 s        │
  │     [Approuver]   [Refuser]          │
  └──────────────────────────────────────┘
  ```
- Au tap Approuver: `auth.pairingApprove(pairingId)` → toast "TV connectée" → retire l'item de la liste.

**Entrée menu user** (`shared/components/user-menu.ts`):
- "Demandes de connexion" avec badge dynamique (computed sur `pairingPending().length`, refetch toutes les 30 s + sur SSE event).
- Affiché uniquement loggé (pas de sens sur la TV non loggée).

#### 4.3.4 — i18n

```json
"select_user": {
  "title": "Qui regarde ?",
  "use_password": "Mot de passe",
  "use_phone": "Connexion via téléphone",
  "other_user": "Saisir un autre utilisateur"
},
"quick_connect": {
  "waiting_title": "En attente de validation",
  "waiting_subtitle": "Ouvrez Fliks sur votre téléphone et acceptez la demande sur la page « Demandes de connexion ».",
  "device_name": "Cet appareil : {{name}}",
  "expires_in": "Expire dans {{minutes}} min",
  "denied": "La demande a été refusée",
  "expired": "La demande a expiré",
  "retry": "Réessayer",
  "cancel": "Annuler"
},
"pending_requests": {
  "title": "Demandes de connexion",
  "empty": "Aucune demande en attente",
  "received_ago": "Reçue il y a {{age}}",
  "approve": "Approuver",
  "deny": "Refuser",
  "approved_toast": "Appareil connecté",
  "denied_toast": "Demande refusée"
}
```

---

## 5. mDNS auto-discovery (esquisse — futur PR3)

**Approche recommandée**: backend Fliks publie un service mDNS `_fliks._tcp.local.` au démarrage; les apps natives écoutent ce service au moment du setup.

- **Backend**: lib `bonjour-service` (npm), 50 lignes dans un `DiscoveryService` qui publie `{ name: 'Fliks', type: 'fliks', port: 3000, txt: { version, instanceId } }`. Activable par config `MDNS_ANNOUNCE=true`.
- **Frontend (Capacitor)**: pas de plugin mDNS officiel. Options:
  1. Plugin community type `@bjornholm/capacitor-zeroconf` (existant sur npm, dernière maj 2024). Vérifier la maintenance.
  2. Plugin custom Android/iOS (NSDManager / NSNetServiceBrowser), ~150 lignes natives.
- **Manifest Android**: `CHANGE_WIFI_MULTICAST_STATE`, `ACCESS_NETWORK_STATE` à ajouter.
- **UX**: dans setup.html, au-dessus de "Serveurs récents", section "Détectés sur le réseau" avec scan automatique; chaque résultat est cliquable comme "Utiliser".

**Pas dans ce plan** — à traiter quand 1+2+3 sont stables.

---

## 6. Une seule MR — ordre d'implémentation

Tout (§§ 1 + 2 + 3 + 4) dans une seule MR. mDNS (§5) reste hors-scope, traité plus tard.

Ordre d'attaque (commits incrémentaux dans la même branche pour faciliter la review):

1. **`feat(login): trim username on submit`** — §1, 1 ligne. Sanity check.
2. **`feat(server-config): persist known servers and surface them on setup`** — §2, frontend only. Sortable, renameable, forgettable.
3. **`feat(auth): public user listing endpoint`** — §3.1 backend, ~30 lignes (controller + users.service.publicList).
4. **`feat(select-user): user picker landing page`** — §3.2 frontend. Nouvelle route, redirection par défaut depuis `/setup`. Bottom sheet avec les 2 options (mot de passe / téléphone). Le bouton "Connexion via téléphone" reste en TODO inerte jusqu'au commit suivant.
5. **`feat(auth): pairing request entity + endpoints`** — §4.2 backend. PairingRequest entity, service, controller, DTO, throttler, cron cleanup. Sans le SSE event d'abord.
6. **`feat(auth): quick connect TV waiting screen + phone pending requests page`** — §4.3 frontend. Branche le bouton "Connexion via téléphone" du commit 4. Page `/quick-connect/:userId` côté TV, page `/pending-requests` côté téléphone. Polling 2 s.
7. **`feat(auth): SSE pairing.requested event for live updates`** — §4.2.4. Refresh live de la liste pending côté téléphone. Bonus, peut être retiré sans casser la feature.
8. **`feat(i18n): pairing + select-user strings (FR + EN)`** — §3 + §4 i18n.
9. **`chore: update plan status`** — marquer §1-4 comme done dans `plans/auth-quickconnect.md`.

Note routing: après merge, `/setup` redirige vers `/select-user` au lieu de `/login`. Les deep links existants vers `/login` restent valides (avec ou sans `?username=`).

Risque global: moyen (nouvelle entity + endpoint public + nouvelle landing page). ~1000 lignes au total. La review peut s'attaquer commit par commit.

---

## 7. Vérification (test plan)

### Trim + historique serveurs
- Login avec ` clement ` (espaces autour) → succès (avant: échec si l'auth strict-match était en place).
- Native: connecter au serveur A, logout, changer de serveur vers B, logout → `/setup` affiche A & B triés par `lastUsedAt`.
- Renommer le serveur A en "Maison" → persiste après redémarrage de l'app.
- "Oublier" le serveur actif → toast bloque l'action ("logout d'abord").
- Web: même comportement via localStorage (10 entrées max, FIFO).

### User picker
- Après setup → redirection sur `/select-user`.
- `GET /auth/users-public` ne renvoie ni email, ni role, ni lastLogin (vérifier le payload).
- User désactivé (`enabled=false`) absent de la liste.
- Clic sur un user → bottom sheet avec les deux options.
- "Saisir un autre utilisateur" → `/login` vide.
- Deep link `/login?username=alice` → form pré-rempli avec username verrouillé.
- TV: D-pad navigue dans la grille; Enter ouvre le sheet; Escape revient.

### Quick connect
- TV: sélection user clement → "Connexion via téléphone" → écran d'attente; côté téléphone (loggé clement) → `/pending-requests` montre la demande live (SSE) ou au refresh.
- Approve sur le téléphone → la TV bascule sur `/` connectée en moins de 4 s (intervalle de poll 2 s + RTT).
- Deny → TV affiche "Refusée" + bouton retry.
- Timeout 10 min → TV "Expirée" + bouton retry.
- **Sécurité** — sniffer le `pairingId` dans les logs réseau côté TV, simuler une autre app qui poll `status/:pairingId` avec un autre `X-Device-Id` après l'approve → réponse `{ status: 'approved' }` **sans `accessToken`** (token déjà consommé OU ne sort pas pour mauvais device).
- **Sécurité** — user alice, tente `POST /auth/pairing/:pairingId/approve` sur un pairing visant clement → 403.
- **Spam** — TV envoie 5 requests en 10 s → la 4e renvoie 429 (rate limit) ou refus avec message "trop de demandes en attente".
- SSE: refresh `/pending-requests` après que la TV émet une nouvelle request → la liste se met à jour sans rafraîchir.
- Cleanup: insérer une row `expiresAt = now()-1h`, déclencher manuellement `cleanupExpired()` → row supprimée.
- Redémarrage backend pendant un pending → la row est en BDD, le polling reprend après que le backend soit up.

### Acceptance globale
- Aucun nouveau warning de build (`ng build`).
- i18n complète FR + EN.
- Pas de régression sur le login mot de passe classique (deep link + flow user picker).

---

## 8. Hors-scope

- **Notifications système / push** — V1 = page dédiée + SSE bonus. Vraie notif (FCM / Web Push) reportée si demandée.
- **QR code** — la sélection user + nom d'appareil suffisent en V1; QR = nice-to-have V2.
- **Sessions / révocation par device** — pas de table Sessions complète aujourd'hui, donc pas de "déconnecter cet appareil distant". Refactor plus large.
- **Refresh tokens** — la TTL JWT 7 d couvre l'usage; reporter.
- **mDNS** — cf. §5, futur.
- **Toggle admin "ne pas exposer la liste users"** — alignement Plex/Jellyfin par défaut; ajouter un setting plus tard si besoin.
