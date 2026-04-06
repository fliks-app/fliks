# Chromecast (Google Cast) dans Suitarr

Ce document décrit le flux bout-en-bout : connexion au dongle / TV, obtention des URLs de stream, et différences web / Android.

## Vue d’ensemble

- **Receiver** : Default Media Receiver Google (`CC1AD845` côté JS, équivalent côté plugin Android).
- **Deux implémentations client** :
  - **Navigateur** : Cast SDK (`chrome.cast` / `cast.framework`).
  - **App Android (Capacitor)** : plugin natif `NativeCast` (`CastPlugin.java`).
- **État partagé** : `CastService` (connexion, position, pause, etc.) et `CastPlayerService` (métadonnées du titre en cours, options qualité / sous-titres, rechargement du flux).

Le backend ne pousse pas la vidéo vers le Chromecast : il expose des **URLs HTTPS/HTTP** que le **receiver** charge. Ces URLs doivent être **joignables depuis le réseau local du Chromecast** (souvent une IP LAN ou un hostname résolu par le dongle).

---

## Backend

### `POST /api/auth/cast-info` (JWT utilisateur requis)

Réponse :

```json
{ "token": "<jwt-cast>", "streamBaseUrl": "https://…" }
```

- **`token`** : JWT dédié au streaming Cast (même `sub` / `username` que l’utilisateur, durée **4 h** — voir `AuthService.generateCastToken`). Utilisé en query `?token=` sur les routes `/api/stream/...` pour que le receiver n’ait pas besoin du cookie de session.
- **`streamBaseUrl`** : base absolue pour construire les URLs que le Chromecast va appeler. Calculée par `resolveStreamPublicBaseUrl` (`backend/src/common/stream-public-base-url.util.ts`) :
  1. Si **`EXTERNAL_URL`** est définie dans l’environnement du serveur → cette valeur (sans slash final).
  2. Sinon → `x-forwarded-proto` (ou `http`) + **`Host`** de la requête `cast-info`.
  3. Sinon → `http://localhost:<PORT>`.

**Important** : pour un Chromecast sur le LAN, définir **`EXTERNAL_URL`** avec une URL que le dongle peut joindre (ex. `http://192.168.1.10:3001`). Sinon le fallback `Host` correspond souvent au domaine public utilisé par le téléphone, ce qui peut être **injoignable** depuis le réseau local du Cast.

### `POST /api/stream/:mediaFileId/playback-info`

Le client envoie un **profil appareil Cast** (dans `CastPlayerService`, profil volontairement restrictif : pas de direct play / remux côté décision Cast → transcode HLS dans la pratique). Le backend renvoie `playMethod`, `playUrl` (relatif), etc. Les **URLs finales Cast** sont assemblées côté client avec `streamBaseUrl` + `castToken`.

### Routes stream utilisées par le Cast

Selon le mode :

| Mode côté Cast | URL typique |
|----------------|-------------|
| Direct play | `/api/stream/:id` + `token` |
| Remux HLS | `/api/stream/:id/remux/index.m3u8` + `token` + `copyAudio=false` |
| Transcode | `/api/stream/:id/:quality/index.m3u8` + `token` |

Les sous-titres sidecar / embedded passent par `/api/stream/:id/subtitles/...` avec le même `token` Cast.

---

## Frontend — séquence principale (`CastPlayerService.reloadCastStream`)

Appelée au lancement Cast depuis le lecteur, au changement de qualité / piste audio / burn-in, ou via `quickStart` (carte « continuer »).

Ordre logique :

1. **`getPlaybackInfo`** avec le profil Cast et les options (burn-in, index audio).
2. Dérivation du **mode** : `direct` / `remux` / `transcode` à partir de `playMethod`.
3. Pour le **transcode**, résolution de la **qualité** (auto / réglages Cast).
4. **`getCastInfo()`** → `token` + `streamBaseUrl` — **le plus tard possible** avant `loadMedia`, pour limiter l’écart entre émission du token et requêtes du receiver.
5. **`CastService.setCastStreamBase(streamBaseUrl)`** : sert à `StreamingApiService` pour les URLs absolues des **sous-titres** (`getAbsoluteSubtitleUrl`, etc.).
6. **`lanUrl`** : `streamBaseUrl` du serveur ; si vide, repli **URL serveur enregistrée** (app native) ou **`window.location.origin`** (web).
7. Construction de **`castUrl`** + liste des sous-titres (URLs absolues + token).
8. **`CastService.loadMedia(...)`** → Web : `chrome.cast` ; natif : `NativeCast.loadMedia`.

À la **déconnexion** Cast, `CastService.disconnect()` remet notamment **`castStreamBaseUrl`** à vide.

---

## App Android

- L’**intercepteur HTTP** réécrit les chemins `/api` vers l’URL serveur configurée (Préférences).
- Si le serveur ne renvoie pas une base adaptée au Cast, le **repli** utilise cette même URL — d’où l’intérêt de **`EXTERNAL_URL`** correcte côté backend pour `cast-info`.
- **`CastPlugin`** : API Cast sur le **thread UI**, gestion du sélecteur d’appareil (`MediaRouteChooserDialogFragment`), événements custom vers la WebView (`castStateChanged`, `castPickerDismissed`, `castMediaUpdate`).

---

## Fichiers utiles (repères)

| Rôle | Emplacement |
|------|-------------|
| `cast-info` + base URL | `backend/src/modules/auth/auth.controller.ts`, `backend/src/common/stream-public-base-url.util.ts` |
| Client `getCastInfo` | `frontend/src/app/core/services/auth.service.ts` |
| Orchestration flux Cast | `frontend/src/app/core/services/cast-player.service.ts` |
| Connexion / lecture | `frontend/src/app/core/services/cast.service.ts` |
| URLs absolues sous-titres | `frontend/src/app/core/services/api/streaming-api.service.ts` |
| Plugin Android | `frontend/android/app/src/main/java/com/fliks/app/CastPlugin.java` |
| Options Cast receiver | `frontend/android/.../CastOptionsProvider.java` |

---

## Dépannage rapide

- **Pas de lecture / erreur réseau sur le Chromecast** : vérifier **`EXTERNAL_URL`** et connectivité LAN du dongle vers l’API.
- **401 sur les segments HLS** : token Cast expiré ou absent — le client doit repasser par `reloadCastStream` (nouvel appel `cast-info`).
- **Picker qui se ferme « comme annulé » alors qu’un appareil est choisi** : logique `sessionPending` / thread principal dans `CastPlugin` (race entre fermeture du dialogue et démarrage de session).
