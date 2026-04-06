# Plan : Compilation pour TV Samsung (Tizen) & LG (webOS)

## Context
Les smart TV Samsung et LG utilisent des plateformes web-based (Tizen et webOS) qui exécutent des apps HTML/CSS/JS. L'app Angular Fliks peut être packagée pour ces plateformes avec des adaptations UI et des outils de build spécifiques.

---

## Samsung TV — Tizen

### Prérequis
- **Tizen Studio** (IDE Samsung) : https://developer.tizen.org/development/tizen-studio
- Compte Samsung Developer ($0, gratuit)
- TV Samsung en mode développeur ou émulateur Tizen

### Étape 1 : Créer le projet Tizen

```bash
# Après build Angular
npm run build

# Créer le dossier Tizen
mkdir -p tv/tizen
```

**Fichier `tv/tizen/config.xml`** :
```xml
<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets"
        xmlns:tizen="http://tizen.org/ns/widgets"
        id="http://fliks.app"
        version="1.0.0"
        viewmodes="maximized">
    <tizen:application id="com.fliks.app" package="com.fliks" required_version="6.0"/>
    <content src="index.html"/>
    <name>Fliks</name>
    <icon src="icon.png"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <feature name="http://tizen.org/feature/screen.size.all"/>
    <tizen:profile name="tv-samsung"/>
</widget>
```

### Étape 2 : Script de build

```bash
# Copier le build Angular dans le dossier Tizen
cp -r dist/frontend/browser/* tv/tizen/

# Packager avec Tizen CLI
tizen build-web -- tv/tizen/
tizen package -t wgt -- tv/tizen/.buildResult/
```

Résultat : fichier `.wgt` installable sur TV Samsung.

### Étape 3 : Déploiement

```bash
# Sur TV en mode dev (connectée au même réseau)
tizen install -n Fliks.wgt -t <TV_IP>:26101
tizen run -p com.fliks.app -t <TV_IP>:26101
```

---

## LG TV — webOS

### Prérequis
- **webOS SDK** (ares-cli) : https://webostv.developer.lge.com/develop/tools/cli-installation
- Compte LG Developer ($0, gratuit)
- TV LG en mode développeur ou émulateur webOS

### Étape 1 : Créer le projet webOS

```bash
mkdir -p tv/webos
```

**Fichier `tv/webos/appinfo.json`** :
```json
{
  "id": "com.fliks.app",
  "version": "1.0.0",
  "vendor": "Fliks",
  "type": "web",
  "main": "index.html",
  "title": "Fliks",
  "icon": "icon.png",
  "largeIcon": "largeIcon.png",
  "bgImage": "splash.png",
  "resolution": "1920x1080",
  "disableBackHistoryAPI": false
}
```

### Étape 2 : Script de build

```bash
# Copier le build Angular
cp -r dist/frontend/browser/* tv/webos/

# Packager avec ares-cli
ares-package tv/webos/
```

Résultat : fichier `.ipk` installable sur TV LG.

### Étape 3 : Déploiement

```bash
# Configurer la TV comme device
ares-setup-device

# Installer et lancer
ares-install --device <tv_name> com.fliks.app_1.0.0_all.ipk
ares-launch --device <tv_name> com.fliks.app
```

---

## Adaptations communes (TV)

### Navigation au pad directionnel (D-pad)

Les TV n'ont pas de souris/touch — navigation par D-pad (haut/bas/gauche/droite/OK/retour). C'est le changement le plus important.

**1. Focus management** : Ajouter une bibliothèque de spatial navigation.

```bash
npm install @nicepkg/gaze # ou norigin-spatial-navigation
```

Alternative : utiliser `tabindex` natif + CSS `:focus-visible` sur tous les éléments interactifs.

**2. CSS pour le focus** — Ajouter dans `styles.css` :
```css
/* TV focus ring */
:focus-visible {
  outline: 3px solid oklch(0.65 0.25 260);
  outline-offset: 2px;
}

/* Agrandir les éléments pour lisibilité TV (distance 3m) */
@media (min-width: 1920px) and (max-height: 1080px) {
  html { font-size: 20px; }
  .btn { min-height: 3.5rem; }
}
```

**3. Gestion du bouton retour** :
```typescript
document.addEventListener('keydown', (e) => {
  if (e.key === 'XF86Back' || e.key === 'GoBack') {
    // Tizen & webOS back button
    window.history.back();
  }
});
```

### URL du serveur

Même mécanisme que pour mobile (voir `mobile-android-ios.plan.md` — écran `/setup`) :
- Écran de saisie au premier lancement avec champ URL + bouton "Tester"
- Stockage en `localStorage` (pas de Capacitor Preferences sur TV)
- Interceptor HTTP qui préfixe les requêtes API
- Navigation D-pad sur l'écran de setup (champ texte + clavier virtuel TV)

**Bonus TV** : Possibilité d'afficher un QR code sur l'écran de setup que l'utilisateur scanne avec son téléphone pour configurer l'URL (évite de taper avec la télécommande).

### Taille UI

- Les TV sont à 1920x1080 mais vues à 3 mètres
- Taille de police minimum : 18px
- Boutons : minimum 48x48px (idéalement 64x64)
- Contraste élevé obligatoire

---

## Structure de fichiers proposée

```
frontend/
├── tv/
│   ├── tizen/
│   │   ├── config.xml
│   │   └── icon.png
│   ├── webos/
│   │   ├── appinfo.json
│   │   ├── icon.png
│   │   └── largeIcon.png
│   └── build.sh          # Script qui build Angular + copie dans tizen/ et webos/
```

**`tv/build.sh`** :
```bash
#!/bin/bash
cd "$(dirname "$0")/.."
npm run build

# Samsung Tizen
rm -rf tv/tizen/!(config.xml|icon.png)
cp -r dist/frontend/browser/* tv/tizen/

# LG webOS
rm -rf tv/webos/!(appinfo.json|icon.png|largeIcon.png)
cp -r dist/frontend/browser/* tv/webos/
```

---

## Points d'attention

1. **Pas de service worker** : Les TV ne supportent généralement pas les service workers. Désactiver pour les builds TV.
2. **WebSocket** : Si l'app utilise SSE/WebSocket pour les événements temps réel, vérifier la compatibilité (Tizen ≥4.0, webOS ≥4.0)
3. **Performances** : Les SoC des TV sont lents. Éviter les animations lourdes, limiter les DOM nodes, utiliser `trackBy` partout.
4. **Certification** : Pour publier sur le Samsung TV Store ou LG Content Store, il faut passer une certification (tests de conformité, QA). Le sideloading en mode dev est plus rapide pour usage personnel.
5. **Résolution** : Tizen supporte 4K (3840x2160) mais le rendu CSS est en 1920x1080 upscalé. Designer pour 1080p.
6. **Vidéo** : Si Fliks intègre un jour la lecture vidéo, utiliser les API natives (`AVPlay` sur Tizen, `webOS video tag`) plutôt que le `<video>` HTML standard.

---

## Estimation effort
- Setup Tizen (config + build + test émulateur) : ~4h
- Setup webOS (config + build + test émulateur) : ~4h
- Adaptations D-pad / focus management : ~8-16h (gros morceau)
- Adaptations UI taille TV : ~4h
- Écran configuration serveur : ~4h (partagé avec mobile)
- Tests sur TV physiques : ~4h
