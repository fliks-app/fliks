# Plan : Compilation Android & iOS via Capacitor

## Context
L'app Suitarr est une SPA Angular 21 avec PWA déjà configurée (service worker, manifest, icônes). Capacitor est le choix naturel pour wrapper l'app web dans un shell natif Android/iOS sans réécrire le code.

## Prérequis
- Node 20+, npm
- Android Studio (pour Android)
- Xcode 15+ sur macOS (pour iOS)
- Compte Apple Developer (pour iOS, $99/an si distribution App Store)

---

## Étape 1 : Installer Capacitor

```bash
cd frontend
npm install @capacitor/core @capacitor/cli
npx cap init Suitarr com.suitarr.app --web-dir dist/frontend/browser
```

Cela crée `capacitor.config.ts` à la racine de `frontend/`.

**Configuration** (`capacitor.config.ts`) :
```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.suitarr.app',
  appName: 'Suitarr',
  webDir: 'dist/frontend/browser',
  server: {
    // En dev, pointer vers le backend pour les requêtes API
    // En prod, l'app est self-contained
    androidScheme: 'https',
  },
};

export default config;
```

---

## Étape 2 : Ajouter les plateformes

```bash
npm install @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios
```

Cela crée les dossiers `android/` et `ios/` dans `frontend/`.

**Important** : Ajouter `android/` et `ios/` au `.gitignore` ou les versionner selon la stratégie choisie.

---

## Étape 3 : Adapter la configuration API

Le problème principal : l'app web fait des requêtes relatives (`/api/...`) qui fonctionnent en web car le proxy ou le serveur backend est sur le même domaine. En natif, il faut pointer vers le serveur Suitarr.

**Solution** : Écran de saisie de l'URL du serveur au premier lancement.

### Implémentation

1. **Plugin stockage** :
```bash
npm install @capacitor/preferences
```

2. **Service `ServerConfigService`** (Angular) :
   - Au démarrage, lire l'URL stockée dans `Preferences`
   - Si absente → afficher l'écran de configuration (route `/setup`)
   - Si présente → configurer le `HttpClient` avec un interceptor qui préfixe toutes les requêtes `/api/...` par l'URL du serveur
   - Bouton "Tester la connexion" pour valider l'URL avant de la sauvegarder
   - L'URL reste modifiable dans les settings de l'app

3. **Écran `/setup`** :
   - Champ texte : "Adresse du serveur Suitarr" (placeholder : `http://192.168.1.x:3000`)
   - Bouton "Tester" → appelle `GET {url}/api/health`
   - Bouton "Enregistrer" (désactivé si test échoué)
   - Cet écran n'est affiché que si aucune URL n'est configurée ou si l'utilisateur y accède depuis les settings

4. **Guard Angular** :
   - `ServerConfigGuard` sur toutes les routes sauf `/setup`
   - Redirige vers `/setup` si l'URL n'est pas configurée

5. **Détection plateforme** :
   - En mode web (navigateur), l'interceptor ne fait rien (requêtes relatives)
   - En mode natif (Capacitor), l'interceptor préfixe avec l'URL configurée
   - Utiliser `Capacitor.isNativePlatform()` pour détecter

---

## Étape 4 : Plugins natifs utiles

```bash
npm install @capacitor/status-bar    # Contrôle de la barre de statut
npm install @capacitor/splash-screen # Écran de chargement natif
npm install @capacitor/app           # Lifecycle events (back button, etc.)
```

---

## Étape 5 : Build & déploiement

### Android
```bash
npm run build                    # Build Angular production
npx cap sync android             # Copier le build dans le projet Android
npx cap open android             # Ouvrir dans Android Studio
```

Depuis Android Studio : Build > Generate Signed APK/Bundle

### iOS
```bash
npm run build
npx cap sync ios
npx cap open ios                 # Ouvrir dans Xcode
```

Depuis Xcode : Product > Archive > Distribute

---

## Étape 6 : Icônes & splash screens

Utiliser `@capacitor/assets` pour générer automatiquement toutes les tailles :

```bash
npm install -D @capacitor/assets
npx capacitor-assets generate --iconBackgroundColor '#1d232a' --splashBackgroundColor '#1d232a'
```

Placer les sources dans :
- `frontend/resources/icon-only.png` (1024x1024, icône)
- `frontend/resources/splash.png` (2732x2732, splash)

---

## Étape 7 : Scripts npm

Ajouter dans `package.json` :
```json
{
  "scripts": {
    "cap:build:android": "npm run build && npx cap sync android",
    "cap:build:ios": "npm run build && npx cap sync ios",
    "cap:run:android": "npx cap run android",
    "cap:run:ios": "npx cap run ios"
  }
}
```

---

## Points d'attention

1. **CORS** : Le serveur backend doit accepter les requêtes depuis `capacitor://localhost` (Android) et `ionic://localhost` (iOS)
2. **HTTPS** : Capacitor utilise `https` par défaut sur Android ; le backend doit être accessible en HTTPS ou configurer `allowMixedContent`
3. **Deep links** : Si besoin de liens profonds, configurer `App Links` (Android) / `Universal Links` (iOS)
4. **Push notifications** : Si nécessaire plus tard, utiliser `@capacitor/push-notifications` + Firebase
5. **Offline** : Le service worker existant donne déjà un support offline partiel
6. **Back button Android** : Gérer via `@capacitor/app` pour la navigation

---

## Estimation effort
- Installation + config de base : ~2h
- Adaptation URL API (écran serveur) : ~4h
- Icônes + splash : ~1h
- Tests sur devices/émulateurs : ~2h
- Build signé + distribution : ~2h
